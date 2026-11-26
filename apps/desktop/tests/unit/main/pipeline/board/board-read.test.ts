import { describe, expect, it } from 'vitest'
import type { BoardPullsFetch, RateLimitInfo } from '@/types/github'
import type { TrackedRef } from '@/types/pipeline-state'
import type { BoardIssuesFetch } from '@/main/github/tracker'
import { mergeBoard, readBoard } from '@/main/pipeline/board/board-read'
import { ghAuthStatus, ghJson } from '@/main/platform/gh'
import { githubHttp } from '@/main/platform/github-http'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import { RATE_LIMIT_REPLY, connection } from '../../../../fixtures/pipeline-reply'
import { REPO, VOCABULARY, issueSweepBody, node, ok, pullSweepBody, scriptedBoard } from '../../../../fixtures/board-script'
import { boardCtx, httpFail } from '../../../../fixtures/github-http'
import { dryRunCostRecorder } from '../../../../support/graphql-cost'
import { item } from '../../state/reconcile-fixtures'

const rate = (cost: number, remaining: number, resetAt = 'r', limit = 5000): RateLimitInfo => ({ cost, remaining, resetAt, limit })

const issuesHalf = (overrides: Partial<Extract<BoardIssuesFetch, { ok: true }>> = {}): BoardIssuesFetch => ({
  ok: true,
  swept: [],
  read: [],
  closed: [],
  unavailable: [],
  truncated: [],
  rateLimit: rate(2, 4990),
  repoLabels: { ok: true, names: VOCABULARY.labels.map((label) => label.name) },
  viewer: 'op',
  ...overrides,
})

const pullsHalf = (overrides: Partial<Extract<BoardPullsFetch, { ok: true }>> = {}): BoardPullsFetch => ({
  ok: true,
  swept: [],
  read: [],
  closed: [],
  merged: [],
  unavailable: [],
  truncated: [],
  rateLimit: rate(3, 4985),
  integrationChecks: { build: 'green' },
  ...overrides,
})

const merge = (issues: BoardIssuesFetch, pulls: BoardPullsFetch, tracked: readonly TrackedRef[] | null = null) => mergeBoard({ issues, pulls, tracked, vocabulary: VOCABULARY, fetchedAt: 'now' })

const issue = (number: number) => item({ number, kind: 'issue' })
const pull = (number: number) => item({ number, kind: 'pull-request' })

describe('mergeBoard', () => {
  it.each([
    ['the issue half fails', { ok: false, kind: 'network', message: 'issues down' }, pullsHalf(), 'network', 'issues down'],
    ['the PR half fails', issuesHalf(), { ok: false, kind: 'rate-limited', message: 'pulls down' }, 'rate-limited', 'pulls down'],
    ['both fail, naming the issue half', { ok: false, kind: 'network', message: 'issues down' }, { ok: false, kind: 'rate-limited', message: 'pulls down' }, 'network', 'issues down'],
  ] as const)('fails closed when %s, never a partial board', (_label, issues, pulls, kind, message) => {
    expect(merge(issues, pulls)).toEqual({ ok: false, kind, message, fetchedAt: 'now' })
  })

  it('lists swept issues, then swept pull requests', () => {
    const result = merge(issuesHalf({ swept: [issue(1), issue(2)] }), pullsHalf({ swept: [pull(3)] }))
    expect(result.ok && result.items.map((entry) => `${entry.kind}:${entry.number}`)).toEqual(['issue:1', 'issue:2', 'pull-request:3'])
  })

  it('lists the by-number reads of both halves in tracked-ref order, after the swept ones, with closed in the same order', () => {
    const tracked: readonly TrackedRef[] = [
      { kind: 'pull-request', number: 9, keys: ['approved'] },
      { kind: 'pull-request', number: 10, keys: ['readyForReview'] },
      { kind: 'issue', number: 3, keys: ['planReview'] },
      { kind: 'issue', number: 4, keys: ['ready'] },
    ]
    const result = merge(issuesHalf({ swept: [issue(4)], read: [issue(3)], closed: [] }), pullsHalf({ read: [pull(9)], closed: [10], merged: [9] }), tracked)
    expect(result.ok && result.items.map((entry) => entry.number)).toEqual([4, 9, 3])
    expect(result.ok && result.closed).toEqual([10])
    const closedAll = merge(issuesHalf({ closed: [3] }), pullsHalf({ closed: [9, 10], merged: [9] }), tracked)
    expect(closedAll.ok && [closedAll.closed, closedAll.merged]).toEqual([[9, 10, 3], [9]])
  })

  it('takes the viewer and the label list from the issue half, and the integration checks from the PR half', () => {
    const result = merge(issuesHalf({ viewer: 'someone', repoLabels: { ok: false, reason: 'truncated' } }), pullsHalf({ integrationChecks: null }))
    expect(result.ok && [result.viewer, result.vocabulary.verdict, result.integrationChecks]).toEqual(['someone', 'unverified', null])
  })

  it('lists the issue entries before the PR entries in unavailable and truncated', () => {
    const result = merge(
      issuesHalf({ unavailable: [{ alias: 'issues', surface: 'issue' }], truncated: [{ alias: 'issues', surface: 'issue', totalCount: 9, received: 5 }] }),
      pullsHalf({ unavailable: [{ alias: 'pullRequests', surface: 'pull-request' }], truncated: [{ alias: 'pullRequests', surface: 'pull-request', totalCount: 7, received: 5 }] }),
    )
    expect(result.ok && [result.unavailable.map((entry) => entry.alias), result.truncated.map((entry) => entry.alias)]).toEqual([['issues', 'pullRequests'], ['issues', 'pullRequests']])
  })

  it.each([
    ['both halves read a budget: the lower remaining wins', rate(2, 4990, 'a'), rate(3, 4985, 'b'), rate(5, 4985, 'b')],
    ['the later reply is the one with the higher remaining', rate(2, 4980, 'a'), rate(3, 4990, 'b'), rate(5, 4980, 'a')],
    ['a half that read none yields to the other', rate(2, 4990, 'a'), { cost: 0, remaining: 0, resetAt: '', limit: 0 }, rate(2, 4990, 'a')],
    ['neither half read a budget', { cost: 0, remaining: 0, resetAt: '', limit: 0 }, { cost: 0, remaining: 0, resetAt: '', limit: 0 }, { cost: 0, remaining: 0, resetAt: '', limit: 0 }],
  ])('rate limit: %s', (_label, issuesLimit, pullsLimit, expected) => {
    const result = merge(issuesHalf({ rateLimit: issuesLimit }), pullsHalf({ rateLimit: pullsLimit }))
    expect(result.ok && result.rateLimit).toEqual(expected)
  })
})

describe('readBoard', () => {
  const read = (board: ReturnType<typeof scriptedBoard>, tracked?: readonly TrackedRef[] | null) => readBoard(boardCtx(board.transport), { repo: REPO, vocabulary: VOCABULARY, integration: 'dev', tracked })

  it('reads both halves into one board: swept issues first, the label list verified, the budget summed', async () => {
    const board = scriptedBoard({
      issues: () => ok(issueSweepBody({ issues: connection([node(1, ['ready'])]), viewer: { login: 'op' } })),
      pulls: () => ok(pullSweepBody({ pullRequests: connection([node(2, ['approved'], { mergedAt: null })]) })),
    })
    const result = await read(board)
    expect(result.ok && result.items.map((entry) => [entry.kind, entry.number])).toEqual([['issue', 1], ['pull-request', 2]])
    expect(result.ok && [result.viewer, result.vocabulary.verdict, result.unavailable, result.truncated]).toEqual(['op', 'verified', [], []])
    expect(result.ok && result.rateLimit.cost).toBe(4)
  })

  it('a tracked issue whose labels are gone is read by number and keeps its stored keys', async () => {
    const board = scriptedBoard({ trackedIssues: () => ok({ data: { repository: { t0: node(3, []) }, rateLimit: RATE_LIMIT_REPLY } }) })
    const result = await read(board, [{ kind: 'issue', number: 3, keys: ['marker', 'planReview'] }])
    expect(result.ok && result.items).toHaveLength(1)
    expect(result.ok && result.items[0]).toMatchObject({ number: 3, matchedKeys: ['marker', 'planReview'] })
  })

  it('reads a tracked issue and tracked pull requests through their own halves, in tracked order', async () => {
    const board = scriptedBoard({
      trackedIssues: () => ok({ data: { repository: { t0: node(3, ['plan review'], { state: 'CLOSED' }) }, rateLimit: RATE_LIMIT_REPLY } }),
      trackedPulls: () =>
        ok({
          data: {
            repository: { t0: node(9, ['approved'], { state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z' }), t1: node(10, ['ready for review'], { state: 'CLOSED', mergedAt: null }) },
            rateLimit: RATE_LIMIT_REPLY,
          },
        }),
    })
    const result = await read(board, [
      { kind: 'pull-request', number: 9, keys: ['marker', 'approved'] },
      { kind: 'pull-request', number: 10, keys: ['marker', 'readyForReview'] },
      { kind: 'issue', number: 3, keys: ['marker', 'planReview'] },
    ])
    expect(result.ok && [result.closed, result.merged]).toEqual([[9, 10, 3], [9]])
  })

  it.each([
    ['a tracked alias GitHub no longer has is closed', 'NOT_FOUND', true],
    ['any other tracked alias error fails the board', 'FORBIDDEN', false],
  ])('%s', async (_label, type, succeeds) => {
    const board = scriptedBoard({ trackedIssues: () => ok({ data: { repository: { t0: null }, rateLimit: RATE_LIMIT_REPLY }, errors: [{ type, path: ['repository', 't0'], message: 'x' }] }) })
    const result = await read(board, [{ kind: 'issue', number: 3, keys: ['marker', 'planReview'] }])
    expect(result.ok).toBe(succeeds)
    expect(result.ok && result.closed).toEqual(succeeds ? [3] : false)
  })

  it('a failure in either half is the whole board failing, with no items', async () => {
    const issuesDown = await read(scriptedBoard({ issues: () => httpFail('network', 502) }))
    const pullsDown = await read(scriptedBoard({ pulls: () => httpFail('unauthenticated', 401) }))
    expect([issuesDown.ok, pullsDown.ok]).toEqual([false, false])
    expect('items' in issuesDown || 'items' in pullsDown).toBe(false)
  })
})

// ctx.skip() when gh is not authenticated, so the suite still runs in an unauthenticated CI
// environment. Resolves the repository with gh repo view rather than a hardcoded slug.
describe('readBoard — live', () => {
  it('matches this repository — every matchedKeys is non-empty and the vocabulary is verified; logs the real and dry-run costs', async (ctx) => {
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

    const recorder = dryRunCostRecorder(githubHttp)
    const vocabulary = resolveVocabulary({ modules: { approvalGate: true, release: true, scope: true } })
    const result = await readBoard(boardCtx(recorder.transport), { repo: { owner, name }, vocabulary, integration: 'dev' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.vocabulary.verdict).toBe('verified')
    for (const entry of result.items) expect(entry.matchedKeys.length).toBeGreaterThan(0)
    console.info(`readBoard rateLimit.cost = ${result.rateLimit.cost}, dry-run total = ${await recorder.total()}`)
  }, 60_000)
})
