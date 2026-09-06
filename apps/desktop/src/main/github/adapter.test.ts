import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '../../shared/labels/vocabulary'
import type { LabelVocabulary } from '../../shared/labels/vocabulary'
import { ghAuthStatus, ghJson } from '../platform/gh'
import type { GhResult } from '../platform/gh'
import { fetchItemsByNumber, fetchItemStates, fetchPipelineItems } from './adapter'
import type { GhRunner } from './adapter'

const VOCABULARY: LabelVocabulary = {
  labels: [
    { key: 'ready', name: 'ready', source: 'default', module: 'core', role: 'trigger' },
    { key: 'planApproved', name: 'plan approved', source: 'default', module: 'core', role: 'trigger' },
  ],
  disabled: [],
  problems: [],
}

function fakeRunner(result: GhResult): GhRunner {
  return () => Promise.resolve(result)
}

function issueNode(number: number, labels: readonly string[] = ['ready']) {
  return {
    number,
    title: `issue ${number}`,
    url: `https://github.com/o/r/issues/${number}`,
    body: '',
    state: 'OPEN',
    assignees: { nodes: [] },
    labels: { nodes: labels.map((name) => ({ name })) },
  }
}

const REPO_LABELS_OK = { totalCount: 2, nodes: [{ name: 'ready' }, { name: 'plan approved' }] }
const RATE_LIMIT = { cost: 1, remaining: 4999, resetAt: '2026-01-01T00:00:00Z' }

describe('fetchPipelineItems', () => {
  it('a full success', async () => {
    const stdout = JSON.stringify({
      data: {
        repository: {
          i0: { totalCount: 1, nodes: [issueNode(1)] },
          p0: { totalCount: 0, nodes: [] },
          i1: { totalCount: 0, nodes: [] },
          p1: { totalCount: 0, nodes: [] },
          repoLabels: REPO_LABELS_OK,
        },
        rateLimit: RATE_LIMIT,
      },
    })
    const result = await fetchPipelineItems({ repo: { owner: 'o', name: 'r' }, vocabulary: VOCABULARY, gh: fakeRunner({ ok: true, stdout, stderr: '' }) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.matchedKeys).toEqual(['ready'])
    expect(result.vocabulary.verdict).toBe('verified')
    expect(result.rateLimit).toEqual(RATE_LIMIT)
    expect(result.unavailable).toEqual([])
    expect(result.truncated).toEqual([])
  })

  it('a partial response returns ok: true with unavailable populated and the surviving items intact', async () => {
    const stdout = JSON.stringify({
      data: {
        repository: {
          i0: { totalCount: 1, nodes: [issueNode(1)] },
          p0: { totalCount: 0, nodes: [] },
          i1: { totalCount: 0, nodes: [] },
          p1: null,
          repoLabels: REPO_LABELS_OK,
        },
        rateLimit: RATE_LIMIT,
      },
      errors: [{ type: 'SOME_ERROR', path: ['repository', 'p1'], message: 'boom' }],
    })
    const result = await fetchPipelineItems({
      repo: { owner: 'o', name: 'r' },
      vocabulary: VOCABULARY,
      gh: fakeRunner({ ok: false, kind: 'unknown', stdout, stderr: 'gh: some errors' }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items).toHaveLength(1)
    expect(result.unavailable).toEqual([{ alias: 'p1', key: 'planApproved', surface: 'pull-request', name: 'plan approved' }])
  })

  it.each([
    ['unauthenticated', { ok: false, kind: 'unauthenticated', stdout: '', stderr: 'gh: (HTTP 401)' } satisfies GhResult],
    ['rate-limited', { ok: false, kind: 'rate-limited', stdout: '', stderr: 'gh: (HTTP 403) rate limit' } satisfies GhResult],
    ['network', { ok: false, kind: 'network', stdout: '', stderr: 'dial tcp: no such host' } satisfies GhResult],
  ])('%s returns ok: false with no items field, not an empty list', async (_label, ghResult) => {
    const result = await fetchPipelineItems({ repo: { owner: 'o', name: 'r' }, vocabulary: VOCABULARY, gh: fakeRunner(ghResult) })
    expect(result.ok).toBe(false)
    expect('items' in result).toBe(false)
  })

  it('a >100-label repository yields verdict: unverified, never a confidently-short list', async () => {
    const nodes = Array.from({ length: 100 }, (_, i) => ({ name: `label-${i}` }))
    const stdout = JSON.stringify({
      data: {
        repository: {
          i0: { totalCount: 0, nodes: [] },
          p0: { totalCount: 0, nodes: [] },
          i1: { totalCount: 0, nodes: [] },
          p1: { totalCount: 0, nodes: [] },
          repoLabels: { totalCount: 150, nodes },
        },
        rateLimit: RATE_LIMIT,
      },
    })
    const result = await fetchPipelineItems({ repo: { owner: 'o', name: 'r' }, vocabulary: VOCABULARY, gh: fakeRunner({ ok: true, stdout, stderr: '' }) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.vocabulary.verdict).toBe('unverified')
  })

  it('names every enabled label in queried, even when items is empty', async () => {
    const stdout = JSON.stringify({
      data: {
        repository: {
          i0: { totalCount: 0, nodes: [] },
          p0: { totalCount: 0, nodes: [] },
          i1: { totalCount: 0, nodes: [] },
          p1: { totalCount: 0, nodes: [] },
          repoLabels: REPO_LABELS_OK,
        },
        rateLimit: RATE_LIMIT,
      },
    })
    const result = await fetchPipelineItems({ repo: { owner: 'o', name: 'r' }, vocabulary: VOCABULARY, gh: fakeRunner({ ok: true, stdout, stderr: '' }) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items).toEqual([])
    expect(result.queried.map((q) => q.key)).toEqual(['ready', 'planApproved'])
  })
})

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
          n0: { __typename: 'Issue', number: 79, title: 'issue', url: 'u1', state: 'OPEN', closedAt: null },
          n1: { __typename: 'PullRequest', number: 196, title: 'pr', url: 'u2', state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z', closedAt: '2026-01-01T00:00:00Z' },
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
      { number: 79, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 'issue', url: 'u1' },
      { number: 196, kind: 'pull-request', state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z', closedAt: '2026-01-01T00:00:00Z', title: 'pr', url: 'u2' },
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

// Gated exactly as `git.test.ts`/`gh.test.ts` gate their own live cases —
// `ctx.skip()` when `gh` is not authenticated, so the suite still runs in an
// unauthenticated CI environment. Resolves the repository with
// `gh repo view` rather than a hardcoded slug, so it is correct in a fork.
// Both gating calls are bounded well under this test's own 30s timeout
// (#200 review): the default 30s command timeout races the test framework's
// own timeout on a slow CI runner, which fails the test on a hang instead of
// classifying as `timeout` (not ok) and skipping cleanly.
describe('fetchPipelineItems / fetchItemStates — live', () => {
  it('matches this repository — every matchedKeys is non-empty, vocabulary is verified, rateLimit.cost is present', async (ctx) => {
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

    const vocabulary = resolveVocabulary({ modules: { approvalGate: true, release: true, scope: true } })
    const result = await fetchPipelineItems({ repo: { owner, name }, vocabulary })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.vocabulary.verdict).toBe('verified')
    expect(typeof result.rateLimit.cost).toBe('number')
    for (const item of result.items) {
      expect(item.matchedKeys.length).toBeGreaterThan(0)
    }
    // Measured cost for #76's pull request `## Notes`.
    console.info(`fetchPipelineItems rateLimit.cost = ${result.rateLimit.cost}`)
  }, 30_000)

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

    // #76 itself — open at the time this suite was written, and re-checking
    // its own tracking issue's state is exactly fetchItemStates's purpose.
    const result = await fetchItemStates({ repo: { owner, name }, items: [{ kind: 'issue', number: 76 }] })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.states).toHaveLength(1)
    expect(typeof result.states[0]?.state).toBe('string')
    expect(result.states[0]?.state.length).toBeGreaterThan(0)
  }, 30_000)
})
