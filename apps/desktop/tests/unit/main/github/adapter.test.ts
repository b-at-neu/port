import { describe, expect, it } from 'vitest'
import { ghAuthStatus, ghJson } from '@/main/platform/gh'
import type { GhResult } from '@/types/platform'
import { fetchClaimPreflight, fetchItemsByNumber, fetchItemStates } from '@/main/github/adapter'
import type { GhRunner } from '@/types/platform'

function fakeRunner(result: GhResult): GhRunner {
  return () => Promise.resolve(result)
}

describe('fetchItemStates', () => {
  it('returns an empty result for no items without spawning gh', async () => {
    let called = false
    const runner: GhRunner = () => {
      called = true
      return Promise.resolve({ ok: true, stdout: '{}', stderr: '' })
    }
    const result = await fetchItemStates({ repo: { owner: 'o', name: 'r' }, items: [], gh: runner })
    expect(result).toEqual({ ok: true, states: [], unavailable: [], fetchedAt: result.ok ? result.fetchedAt : '' })
    expect(called).toBe(false)
  })

  it('reports a vanished number as unavailable, never as still open', async () => {
    const stdout = JSON.stringify({
      data: { repository: { s0: { number: 76, state: 'OPEN', mergedAt: null, closedAt: null, url: 'u' }, s1: null } },
    })
    const result = await fetchItemStates({
      repo: { owner: 'o', name: 'r' },
      items: [
        { kind: 'issue', number: 76 },
        { kind: 'pull-request', number: 999999 },
      ],
      gh: fakeRunner({ ok: false, kind: 'unknown', stdout, stderr: 'gh: some errors' }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.states).toEqual([{ kind: 'issue', number: 76, state: 'OPEN', mergedAt: null, closedAt: null, url: 'u' }])
    expect(result.unavailable).toEqual([{ kind: 'pull-request', number: 999999 }])
  })
})

describe('fetchItemsByNumber', () => {
  it('returns an empty result for no numbers without spawning gh', async () => {
    let called = false
    const runner: GhRunner = () => {
      called = true
      return Promise.resolve({ ok: true, stdout: '{}', stderr: '' })
    }
    const result = await fetchItemsByNumber({ repo: { owner: 'o', name: 'r' }, numbers: [], gh: runner })
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
            assignees: { nodes: [] },
            labels: { nodes: [{ name: 'claude' }, { name: 'approved' }] },
          },
        },
      },
    })
    const result = await fetchItemsByNumber({
      repo: { owner: 'o', name: 'r' },
      numbers: [79, 196],
      gh: fakeRunner({ ok: true, stdout, stderr: '' }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.resolved).toEqual([
      { number: 79, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 'issue', url: 'u1', labels: ['ready'], assignees: ['alice'] },
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
      },
    ])
    expect(result.unavailable).toEqual([])
  })

  it('a merged pull request carries mergedAt', async () => {
    const stdout = JSON.stringify({
      data: { repository: { n0: { __typename: 'PullRequest', number: 1, title: 't', url: 'u', state: 'MERGED', mergedAt: '2026-02-01T00:00:00Z', closedAt: '2026-02-01T00:00:00Z' } } },
    })
    const result = await fetchItemsByNumber({ repo: { owner: 'o', name: 'r' }, numbers: [1], gh: fakeRunner({ ok: true, stdout, stderr: '' }) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.resolved[0]?.mergedAt).toBe('2026-02-01T00:00:00Z')
  })

  it('a null node lands in unavailable, never inferred as a state', async () => {
    const stdout = JSON.stringify({ data: { repository: { n0: null } } })
    const result = await fetchItemsByNumber({ repo: { owner: 'o', name: 'r' }, numbers: [999999], gh: fakeRunner({ ok: true, stdout, stderr: '' }) })
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
    const result = await fetchItemsByNumber({
      repo: { owner: 'o', name: 'r' },
      numbers: [1, 2],
      gh: fakeRunner({ ok: false, kind: 'unknown', stdout, stderr: 'gh: some errors' }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.resolved).toHaveLength(1)
    expect(result.unavailable).toEqual([2])
  })
})

describe('fetchClaimPreflight', () => {
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
    const result = await fetchClaimPreflight({ repo: { owner: 'o', name: 'r' }, number: 93, gh: fakeRunner({ ok: true, stdout, stderr: '' }) })
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
    const result = await fetchClaimPreflight({ repo: { owner: 'o', name: 'r' }, number: 1, gh: fakeRunner({ ok: true, stdout, stderr: '' }) })
    expect(result.ok).toBe(true)
    if (!result.ok || result.item === null) return
    expect(result.item.blockers).toEqual({ ok: true, open: [{ number: 1, title: 'a', url: 'u', state: 'OPEN' }], shown: 2, total: 24 })
  })

  it("a PullRequest node carries only its identity fields — no labels/assignees/blockers were requested", async () => {
    const stdout = JSON.stringify({
      data: { repository: { c0: { __typename: 'PullRequest', number: 5, title: 'pr', url: 'u', state: 'OPEN' } }, viewer: { login: 'alice' } },
    })
    const result = await fetchClaimPreflight({ repo: { owner: 'o', name: 'r' }, number: 5, gh: fakeRunner({ ok: true, stdout, stderr: '' }) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.item).toEqual({ kind: 'pull-request', number: 5, title: 'pr', url: 'u', state: 'OPEN', labels: [], assignees: [], blockers: { ok: true, open: [], shown: 0, total: 0 } })
  })

  it('a null c0 node resolves to item: null, never a failure', async () => {
    const stdout = JSON.stringify({ data: { repository: { c0: null }, viewer: { login: 'alice' } } })
    const result = await fetchClaimPreflight({ repo: { owner: 'o', name: 'r' }, number: 999999, gh: fakeRunner({ ok: true, stdout, stderr: '' }) })
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
    const result = await fetchClaimPreflight({
      repo: { owner: 'o', name: 'r' },
      number: 999999,
      gh: fakeRunner({ ok: false, kind: 'unknown', stdout, stderr: 'gh: some errors' }),
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
    const result = await fetchClaimPreflight({
      repo: { owner: 'o', name: 'r' },
      number: 1,
      gh: fakeRunner({ ok: false, kind: 'unknown', stdout, stderr: 'gh: some errors' }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok || result.item === null) return
    expect(result.item.title).toBe('t')
    expect(result.item.blockers).toEqual({ ok: false, reason: "GitHub reported an error reading this issue's blockers" })
  })

  it('an unresolvable viewer login fails the whole preflight with kind: no-data', async () => {
    const stdout = JSON.stringify({ data: { repository: { c0: null }, viewer: null } })
    const result = await fetchClaimPreflight({ repo: { owner: 'o', name: 'r' }, number: 1, gh: fakeRunner({ ok: true, stdout, stderr: '' }) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('no-data')
  })

  it('a viewer-level partial error fails the whole preflight with kind: no-data', async () => {
    const stdout = JSON.stringify({ data: { repository: { c0: null }, viewer: null }, errors: [{ type: 'SOME_ERROR', path: ['viewer'], message: 'boom' }] })
    const result = await fetchClaimPreflight({
      repo: { owner: 'o', name: 'r' },
      number: 1,
      gh: fakeRunner({ ok: false, kind: 'unknown', stdout, stderr: 'gh: some errors' }),
    })
    expect(result.ok).toBe(false)
  })
})

// ctx.skip() when gh is not authenticated, so the suite still runs in an unauthenticated CI
// environment. Resolves the repository with gh repo view rather than a hardcoded slug.
describe('fetchItemStates — live', () => {
  it('fetchItemStates resolves a real, known-open issue on this repository', async (ctx) => {
    const auth = await ghAuthStatus({ timeoutMs: 8_000 })
    if (!auth.ok || !auth.authenticated) {
      ctx.skip()
      return
    }
    const repoInfo = await ghJson<{ nameWithOwner: string }>(['repo', 'view', '--json', 'nameWithOwner'], { timeoutMs: 8_000 })
    if (!repoInfo.ok) {
      ctx.skip()
      return
    }
    const [owner, name] = repoInfo.data.nameWithOwner.split('/')
    if (owner === undefined || name === undefined) {
      ctx.skip()
      return
    }

    // A known-open tracking issue; re-checking its state is exactly fetchItemStates's purpose.
    const result = await fetchItemStates({ repo: { owner, name }, items: [{ kind: 'issue', number: 76 }] })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.states).toHaveLength(1)
    expect(typeof result.states[0]?.state).toBe('string')
    expect(result.states[0]?.state.length).toBeGreaterThan(0)
  }, 30_000)
})
