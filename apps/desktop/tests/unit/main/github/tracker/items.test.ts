import { describe, expect, it } from 'vitest'
import { readClaimPreflight, readItemsByNumber } from '@/main/github/tracker/items'
import type { GitHubTransport } from '@/types/platform'
import { fakeTransport, graphqlBodyOf, httpFail, httpOk, recordingTransport } from '../../../../fixtures/github-http'

describe('readItemsByNumber', () => {
  it('returns an empty result for no numbers without a request', async () => {
    let called = false
    const github: GitHubTransport = () => {
      called = true
      return Promise.resolve(httpOk('{}'))
    }
    const result = await readItemsByNumber({ repo: { owner: 'o', name: 'r' }, numbers: [], github })
    expect(result).toEqual({ ok: true, resolved: [], unavailable: [], fetchedAt: result.ok ? result.fetchedAt : '' })
    expect(called).toBe(false)
  })

  it('a mixed issue/pull-request response resolves each by its own __typename', async () => {
    const stdout = JSON.stringify({
      data: {
        repository: {
          n0: {
            __typename: 'Issue',
            number: 79,
            title: 'issue',
            url: 'u1',
            state: 'OPEN',
            closedAt: null,
            assignees: { nodes: [{ login: 'alice' }] },
            labels: { nodes: [{ name: 'ready' }] },
          },
          n1: {
            __typename: 'PullRequest',
            number: 196,
            title: 'pr',
            url: 'u2',
            state: 'MERGED',
            mergedAt: '2026-01-01T00:00:00Z',
            closedAt: '2026-01-01T00:00:00Z',
            headRefName: '195-the-branch',
            headRefOid: 'a1b2c3d4',
            author: { login: 'octocat' },
            assignees: { nodes: [] },
            labels: { nodes: [{ name: 'claude' }, { name: 'approved' }] },
          },
        },
      },
    })
    const result = await readItemsByNumber({
      repo: { owner: 'o', name: 'r' },
      numbers: [79, 196],
      github: fakeTransport(httpOk(stdout)),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.resolved).toEqual([
      { number: 79, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 'issue', url: 'u1', labels: ['ready'], assignees: ['alice'], headRefName: null, headRefOid: null, author: null },
      {
        number: 196,
        kind: 'pull-request',
        state: 'MERGED',
        mergedAt: '2026-01-01T00:00:00Z',
        closedAt: '2026-01-01T00:00:00Z',
        title: 'pr',
        url: 'u2',
        labels: ['claude', 'approved'],
        assignees: [],
        headRefName: '195-the-branch',
        headRefOid: 'a1b2c3d4',
        author: 'octocat',
      },
    ])
    expect(result.unavailable).toEqual([])
  })

  it('maps a pull request without a head branch to null, and never reads one off an issue', async () => {
    const stdout = JSON.stringify({
      data: { repository: { n0: { __typename: 'PullRequest', number: 1, title: 't', url: 'u', state: 'OPEN' }, n1: { __typename: 'Issue', number: 2, title: 't', url: 'u', state: 'OPEN', headRefName: 'stray', headRefOid: 'stray' } } },
    })
    const result = await readItemsByNumber({ repo: { owner: 'o', name: 'r' }, numbers: [1, 2], github: fakeTransport(httpOk(stdout)) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.resolved.map((r) => r.headRefName)).toEqual([null, null])
    expect(result.resolved.map((r) => r.headRefOid)).toEqual([null, null])
  })

  it('maps a missing author to null, and never reads one off an issue', async () => {
    const stdout = JSON.stringify({
      data: {
        repository: {
          n0: { __typename: 'PullRequest', number: 1, title: 't', url: 'u', state: 'OPEN', author: null },
          n1: { __typename: 'Issue', number: 2, title: 't', url: 'u', state: 'OPEN', author: { login: 'stray' } },
        },
      },
    })
    const result = await readItemsByNumber({ repo: { owner: 'o', name: 'r' }, numbers: [1, 2], github: fakeTransport(httpOk(stdout)) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.resolved.map((r) => r.author)).toEqual([null, null])
  })

  it('a merged pull request carries mergedAt', async () => {
    const stdout = JSON.stringify({
      data: { repository: { n0: { __typename: 'PullRequest', number: 1, title: 't', url: 'u', state: 'MERGED', mergedAt: '2026-02-01T00:00:00Z', closedAt: '2026-02-01T00:00:00Z' } } },
    })
    const result = await readItemsByNumber({ repo: { owner: 'o', name: 'r' }, numbers: [1], github: fakeTransport(httpOk(stdout)) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.resolved[0]?.mergedAt).toBe('2026-02-01T00:00:00Z')
  })

  it('a null node lands in unavailable, never inferred as a state', async () => {
    const stdout = JSON.stringify({ data: { repository: { n0: null } } })
    const result = await readItemsByNumber({ repo: { owner: 'o', name: 'r' }, numbers: [999999], github: fakeTransport(httpOk(stdout)) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.resolved).toEqual([])
    expect(result.unavailable).toEqual([999999])
  })

  it('a partial error returns ok: true with the survivors', async () => {
    const stdout = JSON.stringify({
      data: { repository: { n0: { __typename: 'Issue', number: 1, title: 't', url: 'u', state: 'OPEN', closedAt: null }, n1: null } },
      errors: [{ type: 'NOT_FOUND', path: ['repository', 'n1'], message: 'boom' }],
    })
    const result = await readItemsByNumber({
      repo: { owner: 'o', name: 'r' },
      numbers: [1, 2],
      github: fakeTransport(httpOk(stdout)),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.resolved).toHaveLength(1)
    expect(result.unavailable).toEqual([2])
  })
})

describe('readClaimPreflight', () => {
  it('resolves an Issue node with its labels, assignees, viewer, and open blockers', async () => {
    const stdout = JSON.stringify({
      data: {
        repository: {
          c0: {
            __typename: 'Issue',
            number: 93,
            title: 'Claim a ticket',
            url: 'u',
            state: 'OPEN',
            labels: { nodes: [{ name: 'enhancement' }] },
            assignees: { nodes: [{ login: 'alice' }] },
            blockedBy: { totalCount: 1, nodes: [{ number: 90, title: 'blocker', url: 'u2', state: 'OPEN' }] },
          },
        },
        viewer: { login: 'alice' },
      },
    })
    const result = await readClaimPreflight({ repo: { owner: 'o', name: 'r' }, number: 93, github: fakeTransport(httpOk(stdout)) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.viewer).toBe('alice')
    expect(result.item).toEqual({
      kind: 'issue',
      number: 93,
      title: 'Claim a ticket',
      url: 'u',
      state: 'OPEN',
      labels: ['enhancement'],
      assignees: ['alice'],
      blockers: { ok: true, open: [{ number: 90, title: 'blocker', url: 'u2', state: 'OPEN' }], shown: 1, total: 1 },
    })
  })

  it('filters closed blockers out of open, but keeps them in shown/total', async () => {
    const stdout = JSON.stringify({
      data: {
        repository: {
          c0: {
            __typename: 'Issue',
            number: 1,
            title: 't',
            url: 'u',
            state: 'OPEN',
            labels: { nodes: [] },
            assignees: { nodes: [] },
            blockedBy: {
              totalCount: 24,
              nodes: [
                { number: 1, title: 'a', url: 'u', state: 'OPEN' },
                { number: 2, title: 'b', url: 'u', state: 'CLOSED' },
              ],
            },
          },
        },
        viewer: { login: 'alice' },
      },
    })
    const result = await readClaimPreflight({ repo: { owner: 'o', name: 'r' }, number: 1, github: fakeTransport(httpOk(stdout)) })
    expect(result.ok).toBe(true)
    if (!result.ok || result.item === null) return
    expect(result.item.blockers).toEqual({ ok: true, open: [{ number: 1, title: 'a', url: 'u', state: 'OPEN' }], shown: 2, total: 24 })
  })

  it("a PullRequest node carries only its identity fields — no labels/assignees/blockers were requested", async () => {
    const stdout = JSON.stringify({
      data: { repository: { c0: { __typename: 'PullRequest', number: 5, title: 'pr', url: 'u', state: 'OPEN' } }, viewer: { login: 'alice' } },
    })
    const result = await readClaimPreflight({ repo: { owner: 'o', name: 'r' }, number: 5, github: fakeTransport(httpOk(stdout)) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.item).toEqual({ kind: 'pull-request', number: 5, title: 'pr', url: 'u', state: 'OPEN', labels: [], assignees: [], blockers: { ok: true, open: [], shown: 0, total: 0 } })
  })

  it('a null c0 node resolves to item: null, never a failure', async () => {
    const stdout = JSON.stringify({ data: { repository: { c0: null }, viewer: { login: 'alice' } } })
    const result = await readClaimPreflight({ repo: { owner: 'o', name: 'r' }, number: 999999, github: fakeTransport(httpOk(stdout)) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.item).toBeNull()
    expect(result.viewer).toBe('alice')
  })

  it('an item-level partial error (path length 2) resolves to item: null, never a failure', async () => {
    const stdout = JSON.stringify({
      data: { repository: { c0: null }, viewer: { login: 'alice' } },
      errors: [{ type: 'NOT_FOUND', path: ['repository', 'c0'], message: 'boom' }],
    })
    const result = await readClaimPreflight({
      repo: { owner: 'o', name: 'r' },
      number: 999999,
      github: fakeTransport(httpOk(stdout)),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.item).toBeNull()
  })

  it('a blockedBy-only partial error reports blockers unreadable, without dropping the rest of the item', async () => {
    const stdout = JSON.stringify({
      data: {
        repository: { c0: { __typename: 'Issue', number: 1, title: 't', url: 'u', state: 'OPEN', labels: { nodes: [] }, assignees: { nodes: [] }, blockedBy: null } },
        viewer: { login: 'alice' },
      },
      errors: [{ type: 'SOME_ERROR', path: ['repository', 'c0', 'blockedBy'], message: 'boom' }],
    })
    const result = await readClaimPreflight({
      repo: { owner: 'o', name: 'r' },
      number: 1,
      github: fakeTransport(httpOk(stdout)),
    })
    expect(result.ok).toBe(true)
    if (!result.ok || result.item === null) return
    expect(result.item.title).toBe('t')
    expect(result.item.blockers).toEqual({ ok: false, reason: "GitHub reported an error reading this issue's blockers" })
  })

  it('an unresolvable viewer login fails the whole preflight with kind: no-data', async () => {
    const stdout = JSON.stringify({ data: { repository: { c0: null }, viewer: null } })
    const result = await readClaimPreflight({ repo: { owner: 'o', name: 'r' }, number: 1, github: fakeTransport(httpOk(stdout)) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('no-data')
  })

  it('a viewer-level partial error fails the whole preflight with kind: no-data', async () => {
    const stdout = JSON.stringify({ data: { repository: { c0: null }, viewer: null }, errors: [{ type: 'SOME_ERROR', path: ['viewer'], message: 'boom' }] })
    const result = await readClaimPreflight({
      repo: { owner: 'o', name: 'r' },
      number: 1,
      github: fakeTransport(httpOk(stdout)),
    })
    expect(result.ok).toBe(false)
  })
})

describe('wire format and failures', () => {
  it('sends the document and owner/name as string variables in one POST to graphql', async () => {
    const { transport, requests } = recordingTransport(() => JSON.stringify({ data: { repository: { c0: null }, viewer: { login: 'alice' } } }))
    await readClaimPreflight({ repo: { owner: 'o', name: 'r' }, number: 7, github: transport })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe('POST')
    expect(requests[0]?.path).toBe('graphql')
    const body = graphqlBodyOf(requests[0])
    expect(body.variables).toEqual({ owner: 'o', name: 'r' })
    expect(body.query).toContain('number: 7')
  })

  it('a 401 is reported as unauthenticated with GitHub-worded message, never as no data', async () => {
    const github = fakeTransport(httpFail('unauthenticated', 401, '{"message":"Bad credentials"}', 'GitHub: Bad credentials (HTTP 401)'))
    const result = await readItemsByNumber({ repo: { owner: 'o', name: 'r' }, numbers: [1], github })
    expect(result).toMatchObject({ ok: false, kind: 'unauthenticated', message: 'GitHub: Bad credentials (HTTP 401)' })
  })

  it('a 422 with a usable data body falls through to the envelope', async () => {
    const body = JSON.stringify({ data: { repository: { n0: { __typename: 'Issue', number: 1, title: 't', url: 'u', state: 'OPEN' } } } })
    const github = fakeTransport(httpFail('unknown', 422, body))
    const result = await readItemsByNumber({ repo: { owner: 'o', name: 'r' }, numbers: [1], github })
    expect(result.ok).toBe(true)
  })
})
