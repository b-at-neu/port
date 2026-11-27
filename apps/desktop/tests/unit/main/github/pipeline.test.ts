import { describe, expect, it } from 'vitest'
import type { DisplayVocabulary } from '@/utils/labels/display'
import type { TrackedRef } from '@/types/pipeline-state'
import { fetchBoardPulls } from '@/main/github/pipeline'
import { RATE_LIMIT_REPLY, connection } from '../../../fixtures/pipeline-reply'
import { REPO, VOCABULARY, emptyDetails, integrationHistoryOf, node, ok, pullSweepBody, scriptedBoard } from '../../../fixtures/board-script'
import { githubCtx, httpFail } from '../../../fixtures/github-http'

function pullsOf(script: Parameters<typeof scriptedBoard>[0], tracked: readonly TrackedRef[] | null = null, vocabulary: DisplayVocabulary = VOCABULARY) {
  const board = scriptedBoard(script)
  return { board, read: fetchBoardPulls(githubCtx(board.transport), { repo: REPO, vocabulary, integration: 'dev', tracked }) }
}

const pull = (number: number, labels: readonly string[], extra: Record<string, unknown> = {}) => node(number, labels, { mergedAt: null, ...extra })

describe('fetchBoardPulls — sweep', () => {
  it('maps swept pull requests and reads their details, with no issue document', async () => {
    const { board, read } = pullsOf({ pulls: () => ok(pullSweepBody({ pullRequests: connection([pull(2, ['approved'])]) })) })
    const result = await read
    expect(result.ok && result.swept.map((item) => [item.number, item.kind, item.matchedKeys])).toEqual([[2, 'pull-request', ['approved']]])
    expect(board.documents.some((document) => document.includes('issues('))).toBe(false)
  })

  it('asks for no connection when no label is enabled, still reading the integration branch', async () => {
    const { board, read } = pullsOf({}, null, { labels: [], problems: [] })
    const result = await read
    expect(result.ok && result.swept).toEqual([])
    expect(board.documents).toHaveLength(1)
    expect(board.documents[0]).not.toContain('pullRequests(')
    expect(board.documents[0]).toContain('integrationHistory:')
  })

  it('pages with the cursor and carries the integration read on page one only', async () => {
    const { board, read } = pullsOf({
      pulls: (_document, page) => (page === 0 ? ok(pullSweepBody({ pullRequests: connection([pull(1, ['approved'])], { hasNextPage: true, endCursor: 'cursor-1' }, 2) })) : ok(pullSweepBody({ pullRequests: connection([pull(2, ['approved'])]) }))),
    })
    const result = await read
    expect(result.ok && result.swept.map((item) => item.number)).toEqual([1, 2])
    expect(board.documents[0]).toContain('integrationHistory:')
    expect(board.documents[1]).toContain('after: "cursor-1"')
    expect(board.documents[1]).not.toContain('integrationHistory:')
  })

  it('stops at the page cap and reports the surface that still had pages', async () => {
    let next = 0
    const { read } = pullsOf({ pulls: () => ok(pullSweepBody({ pullRequests: connection([pull(++next, ['approved'])], { hasNextPage: true, endCursor: `cursor-${next}` }, 5000) })) })
    const result = await read
    expect(result.ok && result.truncated).toEqual([{ alias: 'pullRequests', surface: 'pull-request', totalCount: 5000, received: 10 }])
  })

  it.each([
    ['named in errors', () => ok(pullSweepBody({ pullRequests: null, errors: [{ type: 'SOME_ERROR', path: ['repository', 'pullRequests'], message: 'boom' }] }))],
    ['missing without an error', () => ok(pullSweepBody({}))],
  ])('a connection %s is unavailable, never read as empty', async (_label, reply) => {
    const result = await pullsOf({ pulls: reply }).read
    expect(result.ok && result.unavailable).toEqual([{ alias: 'pullRequests', surface: 'pull-request' }])
  })

  it('a failed page fails the half with no items', async () => {
    const result = await pullsOf({ pulls: (_document, page) => (page === 0 ? ok(pullSweepBody({ pullRequests: connection([pull(1, ['approved'])], { hasNextPage: true, endCursor: 'c' }, 2) })) : httpFail('network', 502)) }).read
    expect(result.ok).toBe(false)
    expect('swept' in result).toBe(false)
  })
})

describe('fetchBoardPulls — integration checks', () => {
  const build = (conclusion: string, startedAt: string): unknown => ({ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion, startedAt })

  it('reads the newest commit first, as the latest concluded status per check, off the first page', async () => {
    const history = integrationHistoryOf([[build('FAILURE', '2026-01-02T00:00:00Z')], [build('SUCCESS', '2026-01-01T00:00:00Z'), { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS', createdAt: '2026-01-01T00:00:00Z' }]])
    const { board, read } = pullsOf({ pulls: () => ok(pullSweepBody({ integrationHistory: history })) })
    const result = await read
    expect(result.ok && result.integrationChecks).toEqual({ test: 'red', 'ci/legacy': 'green' })
    expect(board.documents[0]).toContain('refs/heads/dev')
  })

  it.each([
    ['an integrationHistory error', () => ok(pullSweepBody({ pullRequests: connection([]), errors: [{ message: 'not found', path: ['repository', 'integrationHistory'] }] }))],
    ['a missing branch', () => ok(pullSweepBody({ pullRequests: connection([]), integrationHistory: null }))],
  ])('%s is unreadable, never an empty record, and never fails the half', async (_label, reply) => {
    const result = await pullsOf({ pulls: reply }).read
    expect(result.ok && result.integrationChecks).toBeNull()
  })
})

describe('fetchBoardPulls — details', () => {
  const sweep = () => ok(pullSweepBody({ pullRequests: connection([pull(2, ['approved']), pull(3, ['reviewing']), pull(4, ['implementing'])]) }))
  const rollup = { commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [{ __typename: 'CheckRun', name: 'build', conclusion: 'FAILURE', status: 'COMPLETED' }] } } } }] } }
  const detail = { timelineItems: { nodes: [] }, reviews: { nodes: [] }, comments: { nodes: [] } }

  it('selects the rollup only for a pull request at the approved or reviewing stage', async () => {
    const { board, read } = pullsOf({ pulls: sweep, pullDetails: () => ok({ data: { repository: { d0: { ...detail, ...rollup }, d1: { ...detail, ...rollup }, d2: detail }, rateLimit: RATE_LIMIT_REPLY } }) })
    const result = await read
    expect(result.ok && result.swept.map((item) => item.checkRollup?.map((check) => check.name) ?? null)).toEqual([['build'], ['build'], null])
    expect((board.documents.find((document) => document.includes('d0:')) ?? '').split('...CheckRollupFields')).toHaveLength(3)
  })

  it('chunks the detail read at 100 aliases per round trip', async () => {
    const { board, read } = pullsOf({ pulls: () => ok(pullSweepBody({ pullRequests: connection(Array.from({ length: 101 }, (_, i) => pull(i + 1, ['approved']))) })) })
    const result = await read
    expect(result.ok && result.swept).toHaveLength(101)
    expect(board.documents.filter((document) => document.includes('d0:'))).toHaveLength(2)
  })

  it.each([
    ['a failed call', () => httpFail('network', 502), 'network'],
    ['an alias named in errors', () => ok({ data: { repository: { d0: null, d1: detail, d2: detail }, rateLimit: RATE_LIMIT_REPLY }, errors: [{ type: 'SOME_ERROR', path: ['repository', 'd0'], message: 'boom' }] }), 'no-data'],
    ['a comments error, never per-field on a pull request', () => ok({ data: { repository: { d0: { ...detail, comments: null }, d1: detail, d2: detail }, rateLimit: RATE_LIMIT_REPLY }, errors: [{ type: 'SOME_ERROR', path: ['repository', 'd0', 'comments'], message: 'boom' }] }), 'no-data'],
    ['a null node with no error', () => ok({ data: { repository: { d0: detail, d1: detail, d2: null }, rateLimit: RATE_LIMIT_REPLY } }), 'no-data'],
  ])('%s fails the half', async (_label, reply, kind) => {
    const result = await pullsOf({ pulls: sweep, pullDetails: reply }).read
    expect(result.ok).toBe(false)
    expect(!result.ok && result.kind).toBe(kind)
  })

  it('sums the cost of every round trip and keeps the last reply\'s budget', async () => {
    const result = await pullsOf({
      pulls: () => ok(pullSweepBody({ pullRequests: connection([pull(2, ['approved'])]), rateLimit: { cost: 2, remaining: 4990, resetAt: 'a', limit: 5000 } })),
      pullDetails: (document) => emptyDetails(document, { cost: 3, remaining: 4987, resetAt: 'b', limit: 5000 }),
    }).read
    expect(result.ok && result.rateLimit).toEqual({ cost: 5, remaining: 4987, resetAt: 'b', limit: 5000 })
  })
})

describe('fetchBoardPulls — tracked', () => {
  const PR_REF: TrackedRef = { kind: 'pull-request', number: 9 }
  const CLOSED_REF: TrackedRef = { kind: 'pull-request', number: 10 }

  it('reads a tracked pull request whose labels are gone by number, and drops an untracked swept one', async () => {
    const { board, read } = pullsOf({ pulls: () => ok(pullSweepBody({ pullRequests: connection([pull(1, ['approved'])]) })), trackedPulls: () => ok({ data: { repository: { t0: pull(9, []) }, rateLimit: RATE_LIMIT_REPLY } }) }, [PR_REF])
    const result = await read
    expect(result.ok && result.swept).toEqual([])
    expect(result.ok && result.read[0]).toMatchObject({ number: 9, kind: 'pull-request', matchedKeys: [] })
    expect(board.documents.find((document) => document.includes('t0:'))).toContain('t0: pullRequest(number: 9)')
  })

  it('reports a merged tracked pull request in merged and closed, and an unmerged close in closed only', async () => {
    const { read } = pullsOf(
      { trackedPulls: () => ok({ data: { repository: { t0: pull(9, ['approved'], { state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z' }), t1: pull(10, ['reviewing'], { state: 'CLOSED' }) }, rateLimit: RATE_LIMIT_REPLY } }) },
      [PR_REF, CLOSED_REF],
    )
    const result = await read
    expect(result.ok && [result.closed, result.merged]).toEqual([[9, 10], [9]])
  })

  it('costs no by-number read when every tracked pull request was swept', async () => {
    const { board, read } = pullsOf({ pulls: () => ok(pullSweepBody({ pullRequests: connection([pull(9, ['reviewing'])]) })) }, [PR_REF])
    const result = await read
    expect(result.ok && result.swept[0]?.matchedKeys).toEqual(['reviewing'])
    expect(board.documents.some((document) => document.includes('t0:'))).toBe(false)
  })

  it.each([
    ['NOT_FOUND', 'NOT_FOUND', true],
    ['any other error', 'FORBIDDEN', false],
  ])('a tracked alias erroring with %s', async (_label, type, closed) => {
    const result = await pullsOf({ trackedPulls: () => ok({ data: { repository: { t0: null }, rateLimit: RATE_LIMIT_REPLY }, errors: [{ type, path: ['repository', 't0'], message: 'x' }] }) }, [PR_REF]).read
    expect(result.ok).toBe(closed)
    expect(result.ok && result.closed).toEqual(closed ? [9] : false)
  })
})
