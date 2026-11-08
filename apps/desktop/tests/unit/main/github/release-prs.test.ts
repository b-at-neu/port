import { describe, expect, it } from 'vitest'
import type { GitHubHttpResult, GitHubRequest } from '@/types/platform'
import { CAPPED_NOTE, MAX_PAGES, PARTIAL_NOTE, readMergedPrs } from '@/main/github/release-prs'
import { buildMergedPrsQuery } from '@/main/github/release-query'
import { graphqlBodyOf, httpFail, recordingTransport } from '../../../fixtures/github-http'

const REPO = { owner: 'acme', name: 'widgets' }
const SINCE = '2026-08-01T00:00:00Z'

interface Node {
  readonly number: number
  readonly mergedAt: string
  readonly updatedAt: string
}

function node(number: number, mergedAt: string, updatedAt = mergedAt): Node {
  return { number, mergedAt, updatedAt }
}

function page(nodes: readonly Node[], next: string | null): string {
  const full = nodes.map((entry) => ({ ...entry, title: `#${String(entry.number)} change ${String(entry.number)}`, url: `u/${String(entry.number)}`, author: { __typename: 'User' }, labels: { nodes: [{ name: 'bug', color: 'd73a4a' }] } }))
  return JSON.stringify({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes: full } } } })
}

function read(pages: readonly (string | GitHubHttpResult)[], over: { since?: string | null; until?: string | null } = {}) {
  const { transport, requests } = recordingTransport((_request, index) => pages[index] ?? page([], null))
  const result = readMergedPrs({ github: transport, repo: REPO, base: 'dev', since: SINCE, until: null, ...over })
  return { result, requests }
}

describe('readMergedPrs', () => {
  it('maps a node to an entry with a cleaned title and real label colours', async () => {
    const { result } = read([page([node(7, '2026-08-05T00:00:00Z')], null)])
    expect(await result).toEqual({
      ok: true,
      note: null,
      entries: [{ number: 7, title: 'change 7', url: 'u/7', labels: [{ name: 'bug', color: 'd73a4a' }], mergedAt: '2026-08-05T00:00:00Z', dependency: false }],
    })
  })

  it('marks a bot author or a dependency label as a dependency', async () => {
    const body = JSON.stringify({
      data: {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              { number: 2, title: 'Bump vite', url: 'u', mergedAt: '2026-08-05T00:00:00Z', updatedAt: '2026-08-05T00:00:00Z', author: { __typename: 'Bot' }, labels: { nodes: [] } },
              { number: 1, title: 'Bump lock', url: 'u', mergedAt: '2026-08-04T00:00:00Z', updatedAt: '2026-08-04T00:00:00Z', author: { __typename: 'User' }, labels: { nodes: [{ name: 'dependencies', color: '0366d6' }] } },
            ],
          },
        },
      },
    })
    const result = await read([body]).result
    expect(result.ok && result.entries.map((entry) => entry.dependency)).toEqual([true, true])
  })

  it('stops paging at the first page whose last node was updated before since', async () => {
    const first = page([node(9, '2026-08-09T00:00:00Z'), node(8, '2026-08-08T00:00:00Z')], 'c1')
    const second = page([node(7, '2026-08-07T00:00:00Z'), node(3, '2026-07-01T00:00:00Z')], 'c2')
    const { result, requests } = read([first, second, page([node(2, '2026-06-01T00:00:00Z')], null)])
    const done = await result
    expect(done.ok && done.entries.map((entry) => entry.number)).toEqual([9, 8, 7])
    expect(requests).toHaveLength(2)
  })

  it('drops a PR updated after since but merged before it, and sorts by merge time', async () => {
    const { result } = read([page([node(5, '2026-07-30T00:00:00Z', '2026-08-10T00:00:00Z'), node(6, '2026-08-03T00:00:00Z', '2026-08-04T00:00:00Z'), node(7, '2026-08-06T00:00:00Z', '2026-08-06T00:00:00Z')], null)])
    const done = await result
    expect(done.ok && done.entries.map((entry) => entry.number)).toEqual([7, 6])
  })

  it('excludes merges after until', async () => {
    const { result } = read([page([node(9, '2026-08-09T00:00:00Z'), node(8, '2026-08-08T00:00:00Z'), node(7, '2026-08-07T00:00:00Z')], null)], { until: '2026-08-08T00:00:00Z' })
    const done = await result
    expect(done.ok && done.entries.map((entry) => entry.number)).toEqual([8, 7])
  })

  it('reads to exhaustion without a prior release', async () => {
    const { result, requests } = read([page([node(3, '2020-01-01T00:00:00Z')], 'c1'), page([node(2, '2019-01-01T00:00:00Z')], 'c2'), page([node(1, '2018-01-01T00:00:00Z')], null)], { since: null })
    const done = await result
    expect(done.ok && done.entries.map((entry) => entry.number)).toEqual([3, 2, 1])
    expect(requests).toHaveLength(3)
  })

  it('keeps what it read and notes the cap when more pages remain', async () => {
    const pages = Array.from({ length: MAX_PAGES + 1 }, (_, index) => page([node(100 - index, '2026-09-01T00:00:00Z')], `c${String(index)}`))
    const { result, requests } = read(pages)
    const done = await result
    expect(done).toMatchObject({ ok: true, note: CAPPED_NOTE })
    expect(done.ok && done.entries).toHaveLength(MAX_PAGES)
    expect(requests).toHaveLength(MAX_PAGES)
  })

  it('fails the whole read on a page-1 failure', async () => {
    const done = await read([httpFail('unauthenticated', 401, '', 'GitHub: Bad credentials (HTTP 401)')]).result
    expect(done).toEqual({ ok: false, message: "Couldn't read the merged PRs: GitHub: Bad credentials (HTTP 401)" })
  })

  it('fails the whole read on a page-1 envelope error', async () => {
    const body = JSON.stringify({ data: { repository: { pullRequests: null } }, errors: [{ message: 'boom', path: ['repository', 'pullRequests'] }] })
    const done = await read([body]).result
    expect(done.ok).toBe(false)
  })

  it('keeps earlier pages with a note when a later page fails', async () => {
    const pages = [page([node(9, '2026-08-09T00:00:00Z')], 'c1'), page([node(8, '2026-08-08T00:00:00Z')], 'c2'), httpFail('network', 502, '', 'GitHub: HTTP 502')]
    const { result, requests } = read(pages)
    const done = await result
    expect(done).toMatchObject({ ok: true, note: PARTIAL_NOTE })
    expect(done.ok && done.entries.map((entry) => entry.number)).toEqual([9, 8])
    expect(requests).toHaveLength(3)
  })

  it('skips a malformed node instead of guessing', async () => {
    const body = JSON.stringify({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ number: 'x' }, { number: 4, title: 't', url: 'u', mergedAt: 'not-a-date', updatedAt: SINCE }] } } } })
    const done = await read([body]).result
    expect(done.ok && done.entries).toEqual([])
  })

  it('sends the base and cursor as variables, never in the document', async () => {
    const { result, requests } = read([page([node(9, '2026-08-09T00:00:00Z')], 'cursor-1'), page([], null)])
    await result
    const [first, second] = requests as [GitHubRequest, GitHubRequest]
    expect(graphqlBodyOf(first).variables).toMatchObject({ base: 'dev' })
    expect(graphqlBodyOf(first).variables).not.toHaveProperty('after')
    expect(graphqlBodyOf(second).variables).toMatchObject({ base: 'dev', after: 'cursor-1' })
    expect(buildMergedPrsQuery()).toContain('baseRefName: $base')
    expect(buildMergedPrsQuery()).toContain('states: MERGED')
    expect(buildMergedPrsQuery()).not.toContain('dev')
  })
})
