import { describe, expect, it } from 'vitest'
import type { GitHubHttpResult, GitHubRequest } from '@/types/platform'
import { fetchReleaseIssues } from '@/main/github/release-issues'
import { buildIncludedIssuesQuery } from '@/main/github/release-query'
import { graphqlBodyOf, httpFail, httpOk, recordingTransport } from '../../../fixtures/github-http'

const REPO = { owner: 'acme', name: 'widgets' }
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)

function commit(sha: string, parents = 1): unknown {
  return { sha, parents: Array.from({ length: parents }, () => ({ sha: 'p' })) }
}

function issue(number: number, overrides: Record<string, unknown> = {}): unknown {
  return { number, title: `Ticket ${String(number)}`, url: `https://github.com/acme/widgets/issues/${String(number)}`, repository: { nameWithOwner: 'acme/widgets' }, labels: { nodes: [{ name: 'bug', color: 'D73A4A' }] }, ...overrides }
}

function pull(merged: boolean, issues: readonly unknown[]): unknown {
  return { merged, closingIssuesReferences: { nodes: issues } }
}

function alias(...pulls: readonly unknown[]): unknown {
  return { associatedPullRequests: { nodes: pulls } }
}

interface Scenario {
  readonly rest?: unknown
  readonly restReply?: GitHubHttpResult
  readonly repository?: Record<string, unknown>
  readonly errors?: readonly { path: readonly (string | number)[]; message: string }[]
}

function run(scenario: Scenario, params: { tag?: string; previousTag?: string | null } = {}) {
  const { transport, requests } = recordingTransport((request: GitHubRequest) => {
    if (request.path === 'graphql') return JSON.stringify({ data: { repository: scenario.repository ?? {} }, ...(scenario.errors === undefined ? {} : { errors: scenario.errors }) })
    return scenario.restReply ?? JSON.stringify(scenario.rest)
  })
  const result = fetchReleaseIssues({ repo: REPO, tag: params.tag ?? 'v0.2.0', previousTag: params.previousTag === undefined ? 'v0.1.0' : params.previousTag, github: transport })
  return { result, requests }
}

const COMPARE = { total_commits: 1, commits: [commit(SHA_A)] }

describe('fetchReleaseIssues', () => {
  it('compares the two tags, resolves each commit and lists the closed tickets newest first', async () => {
    const { result, requests } = run({ rest: { total_commits: 2, commits: [commit(SHA_A), commit(SHA_B)] }, repository: { c0: alias(pull(true, [issue(7), issue(12)])), c1: alias(pull(true, [issue(9)])) } })
    expect(await result).toEqual({
      ok: true,
      issues: [
        { number: 12, title: 'Ticket 12', url: 'https://github.com/acme/widgets/issues/12', labels: [{ name: 'bug', color: 'd73a4a' }] },
        { number: 9, title: 'Ticket 9', url: 'https://github.com/acme/widgets/issues/9', labels: [{ name: 'bug', color: 'd73a4a' }] },
        { number: 7, title: 'Ticket 7', url: 'https://github.com/acme/widgets/issues/7', labels: [{ name: 'bug', color: 'd73a4a' }] },
      ],
      note: null,
    })
    expect(requests[0]?.path).toBe('repos/acme/widgets/compare/v0.1.0...v0.2.0?per_page=100')
  })

  it('reads the newest commits of the tag when there is no previous release', async () => {
    const { result, requests } = run({ rest: [commit(SHA_A)], repository: { c0: alias(pull(true, [issue(3)])) } }, { previousTag: null })
    expect(await result).toMatchObject({ ok: true, issues: [{ number: 3 }], note: null })
    expect(requests[0]?.path).toBe('repos/acme/widgets/commits?sha=v0.2.0&per_page=100')
  })

  it('encodes both tags into the REST path', async () => {
    const { result, requests } = run({ rest: { total_commits: 0, commits: [] } }, { tag: 'v1.0.0+build/1', previousTag: 'rel/v0.9' })
    await result
    expect(requests[0]?.path).toBe('repos/acme/widgets/compare/rel%2Fv0.9...v1.0.0%2Bbuild%2F1?per_page=100')
  })

  it('skips merge commits and sends the remaining shas as variables, never in the document', async () => {
    const { result, requests } = run({ rest: { total_commits: 2, commits: [commit(SHA_A, 2), commit(SHA_B)] }, repository: { c0: alias(pull(true, [issue(5)])) } })
    expect(await result).toMatchObject({ ok: true, issues: [{ number: 5 }] })
    const body = graphqlBodyOf(requests[1])
    expect(body.variables).toMatchObject({ c0: SHA_B })
    expect(body.variables).not.toHaveProperty('c1')
    expect(body.query).not.toContain(SHA_B)
  })

  it('drops a commit whose sha is not forty hex characters', async () => {
    const { result, requests } = run({ rest: { total_commits: 2, commits: [commit('abc"} evil'), commit(SHA_A)] }, repository: { c0: alias(pull(true, [])) } })
    await result
    expect(graphqlBodyOf(requests[1]).variables).toMatchObject({ c0: SHA_A })
  })

  it('ignores a pull request that is not merged', async () => {
    const { result } = run({ rest: COMPARE, repository: { c0: alias(pull(false, [issue(4)]), pull(true, [issue(5)])) } })
    expect(await result).toMatchObject({ ok: true, issues: [{ number: 5 }] })
  })

  it("drops an issue from another repository, whatever the letter case of this one's name", async () => {
    const { result } = run({ rest: COMPARE, repository: { c0: alias(pull(true, [issue(4, { repository: { nameWithOwner: 'other/repo' } }), issue(5, { repository: { nameWithOwner: 'Acme/Widgets' } })])) } })
    expect(await result).toMatchObject({ ok: true, issues: [{ number: 5 }] })
  })

  it('lists a ticket closed by two commits once', async () => {
    const { result } = run({ rest: { total_commits: 2, commits: [commit(SHA_A), commit(SHA_B)] }, repository: { c0: alias(pull(true, [issue(5)])), c1: alias(pull(true, [issue(5)])) } })
    const read = await result
    expect(read.ok && read.issues.map((i) => i.number)).toEqual([5])
  })

  it('returns no issues without a second call when the release has no commits', async () => {
    const { result, requests } = run({ rest: { total_commits: 0, commits: [] } })
    expect(await result).toEqual({ ok: true, issues: [], note: null })
    expect(requests).toHaveLength(1)
  })

  it('drops the commit a per-alias error names and notes the list may be incomplete', async () => {
    const { result } = run({
      rest: { total_commits: 2, commits: [commit(SHA_A), commit(SHA_B)] },
      repository: { c0: null, c1: alias(pull(true, [issue(9)])) },
      errors: [{ path: ['repository', 'c0'], message: 'boom' }],
    })
    expect(await result).toEqual({ ok: true, issues: [expect.objectContaining({ number: 9 })], note: "Some PRs couldn't be read, so this list may be incomplete." })
  })

  it('fails the whole read when the transport fails, or the query returns no data', async () => {
    expect(await run({ restReply: httpFail('unauthenticated', 401, '', 'GitHub: Bad credentials (HTTP 401)') }).result).toEqual({ ok: false, message: 'GitHub: Bad credentials (HTTP 401)' })
    expect(await run({ rest: 'nope', restReply: httpOk('not json') }).result).toEqual({ ok: false, message: "GitHub's comparison wasn't JSON" })
    const { transport } = recordingTransport((request) => (request.path === 'graphql' ? httpFail('forbidden', 403, '', 'GitHub: forbidden (HTTP 403)') : JSON.stringify(COMPARE)))
    expect(await fetchReleaseIssues({ repo: REPO, tag: 'v0.2.0', previousTag: 'v0.1.0', github: transport })).toEqual({ ok: false, message: 'GitHub: forbidden (HTTP 403)' })
  })

  it('notes a compare that returned fewer commits than the release holds', async () => {
    const { result } = run({ rest: { total_commits: 240, commits: [commit(SHA_A)] }, repository: { c0: alias() } })
    expect(await result).toEqual({ ok: true, issues: [], note: 'Read the first 1 of 240 commits, so some tickets may be missing.' })
  })

  it('notes a first release whose log filled the page', async () => {
    const commits = Array.from({ length: 100 }, () => commit(SHA_C))
    const { result } = run({ rest: commits, repository: { c0: alias() } }, { previousTag: null })
    expect(await result).toMatchObject({ ok: true, note: 'This is the first release, so only its newest 100 commits were read.' })
  })

  it('joins a cap note and a partial note with a space', async () => {
    const { result } = run({ rest: { total_commits: 5, commits: [commit(SHA_A)] }, repository: { c0: null }, errors: [{ path: ['repository', 'c0'], message: 'boom' }] })
    expect(await result).toMatchObject({ note: "Read the first 1 of 5 commits, so some tickets may be missing. Some PRs couldn't be read, so this list may be incomplete." })
  })
})

describe('buildIncludedIssuesQuery', () => {
  it('declares one GitObjectID variable and one alias per commit', () => {
    const query = buildIncludedIssuesQuery(2)
    expect(query).toContain('$c0: GitObjectID!, $c1: GitObjectID!')
    expect(query).toContain('c0: object(oid: $c0)')
    expect(query).toContain('c1: object(oid: $c1)')
    expect(query).toContain('closingIssuesReferences(first: 10)')
    expect(query).not.toContain('search(')
  })
})
