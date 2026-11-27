import { describe, expect, it } from 'vitest'
import type { DisplayVocabulary } from '@/utils/labels/display'
import type { PipelineItem } from '@/types/github'
import type { TrackedRef } from '@/types/pipeline-state'
import { readBoardIssues } from '@/main/github/tracker/board'
import { RATE_LIMIT_REPLY, connection } from '../../../../fixtures/pipeline-reply'
import { REPO, VOCABULARY, emptyDetails, issueSweepBody, node, ok, scriptedBoard } from '../../../../fixtures/board-script'
import { githubCtx, httpFail } from '../../../../fixtures/github-http'

function issuesOf(script: Parameters<typeof scriptedBoard>[0], tracked: readonly TrackedRef[] | null = null, vocabulary: DisplayVocabulary = VOCABULARY) {
  const board = scriptedBoard(script)
  return { board, read: readBoardIssues(githubCtx(board.transport), { repo: REPO, vocabulary, tracked }) }
}

const empty = { timelineItems: { nodes: [] }, blockedBy: { totalCount: 0, nodes: [] } }
const lineOf = (document: string, alias: string) => document.split('\n').find((line) => line.includes(`${alias}:`)) ?? ''

describe('readBoardIssues — sweep', () => {
  it('an item with two vocabulary labels and a non-vocabulary label is one item with two keys', async () => {
    const labels = ['planning', 'bug', 'needs you']
    const result = await issuesOf({ issues: () => ok(issueSweepBody({ issues: connection([node(1, labels)]) })) }).read
    expect(result.ok && result.swept).toHaveLength(1)
    expect(result.ok && result.swept[0]?.matchedKeys).toEqual(['needsYou', 'planning'])
    expect(result.ok && result.swept[0]?.labels).toEqual(labels)
  })

  it('asks for no connection when no label is enabled, still reading the label list and the viewer', async () => {
    const { board, read } = issuesOf({ issues: () => ok(issueSweepBody({ viewer: { login: 'op' } })) }, null, { labels: [], problems: [] })
    const result = await read
    expect(result.ok && [result.swept, result.viewer]).toEqual([[], 'op'])
    expect(board.documents).toHaveLength(1)
    expect(board.documents[0]).not.toContain('issues(')
  })

  it('pages with the cursor, and only page one carries the label list and viewer', async () => {
    const { board, read } = issuesOf({
      issues: (_document, page) => (page === 0 ? ok(issueSweepBody({ issues: connection([node(1, ['planning'])], { hasNextPage: true, endCursor: 'cursor-1' }, 2) })) : ok(issueSweepBody({ issues: connection([node(2, ['planning'])]) }))),
    })
    const result = await read
    expect(result.ok && result.swept.map((item) => item.number)).toEqual([1, 2])
    expect(board.documents[1]).toContain('after: "cursor-1"')
    expect(board.documents[0]).toContain('viewer { login }')
    expect(board.documents[1]).not.toContain('viewer')
    expect(board.documents[1]).not.toContain('repoLabels')
  })

  it('stops at the page cap and reports the surface that still had pages', async () => {
    let next = 0
    const { read } = issuesOf({ issues: () => ok(issueSweepBody({ issues: connection([node(++next, ['planning'])], { hasNextPage: true, endCursor: `cursor-${next}` }, 5000) })) })
    const result = await read
    expect(result.ok && result.truncated).toEqual([{ alias: 'issues', surface: 'issue', totalCount: 5000, received: 10 }])
    expect(result.ok && result.swept).toHaveLength(10)
  })

  it.each([
    ['named in errors', () => ok(issueSweepBody({ issues: null, errors: [{ type: 'SOME_ERROR', path: ['repository', 'issues'], message: 'boom' }] }))],
    ['missing without an error', () => ok(issueSweepBody({}))],
  ])('a connection %s is unavailable, never read as empty', async (_label, reply) => {
    const result = await issuesOf({ issues: reply }).read
    expect(result.ok && result.unavailable).toEqual([{ alias: 'issues', surface: 'issue' }])
  })

  it('a failed later page fails the half, never a short list', async () => {
    const result = await issuesOf({ issues: (_document, page) => (page === 0 ? ok(issueSweepBody({ issues: connection([node(1, ['planning'])], { hasNextPage: true, endCursor: 'c' }, 2) })) : httpFail('network', 502)) }).read
    expect(result.ok).toBe(false)
    expect('swept' in result).toBe(false)
  })
})

describe('readBoardIssues — label list and viewer', () => {
  it('a >100-label repository is unverified, never a confidently-short list', async () => {
    const nodes = Array.from({ length: 100 }, (_, i) => ({ name: `label-${i}` }))
    const result = await issuesOf({ issues: () => ok(issueSweepBody({ issues: connection([]), repoLabels: { totalCount: 150, nodes } })) }).read
    expect(result.ok && result.repoLabels).toEqual({ ok: false, reason: 'label list truncated at 100 of 150' })
  })

  it.each([
    ['present', { login: 'op' }, undefined, 'op'],
    ['absent', undefined, undefined, null],
    ['errored', null, [{ type: 'SOME_ERROR', path: ['viewer'], message: 'boom' }], null],
  ] as const)('viewer %s resolves to %s', async (_label, viewer, errors, expected) => {
    const result = await issuesOf({ issues: () => ok(issueSweepBody({ issues: connection([]), viewer, errors })) }).read
    expect(result.ok && result.viewer).toBe(expected)
  })
})

describe('readBoardIssues — details', () => {
  const issue = (number: number, label: string) => node(number, [label])

  it('selects comments only on a needs-you issue, and closing pull requests only on the later stages, mapping both', async () => {
    const comment = { body: 'why', createdAt: '2026-01-01T00:00:00Z', url: 'https://x/c' }
    const closing = (nodes: readonly unknown[]) => ({ ...empty, closedByPullRequestsReferences: { nodes } })
    const { board, read } = issuesOf({
      issues: () => ok(issueSweepBody({ issues: connection([issue(1, 'implementing'), issue(2, 'reviewing'), issue(3, 'revising'), issue(5, 'needs you'), issue(4, 'planning')]) })),
      issueDetails: () =>
        ok({ data: { repository: { d0: closing([{ number: 9, state: 'MERGED' }]), d1: closing([]), d2: closing([]), d3: { ...closing([]), comments: { nodes: [comment] } }, d4: empty }, rateLimit: RATE_LIMIT_REPLY } }),
    })
    const result = await read
    const document = board.documents.find((entry) => entry.includes('d0:')) ?? ''
    expect(['d0', 'd1', 'd2', 'd3', 'd4'].map((alias) => lineOf(document, alias).includes('closedByPullRequestsReferences'))).toEqual([true, true, true, true, false])
    expect(['d0', 'd1', 'd2', 'd3', 'd4'].map((alias) => lineOf(document, alias).includes('comments(last: 10)'))).toEqual([false, false, false, true, false])
    expect(result.ok && result.swept[0]?.closingPullRequests).toEqual([{ number: 9, state: 'MERGED', headRefName: null }])
    expect(result.ok && result.swept[3]?.blockerComments).toEqual([comment])
    expect(result.ok && result.swept[4]?.closingPullRequests).toBeNull()
  })

  it('chunks the detail read at 100 aliases per round trip', async () => {
    const { board, read } = issuesOf({ issues: () => ok(issueSweepBody({ issues: connection(Array.from({ length: 101 }, (_, i) => issue(i + 1, 'planning'))) })) })
    const result = await read
    expect(result.ok && result.swept).toHaveLength(101)
    expect(board.documents.filter((document) => document.includes('d0:'))).toHaveLength(2)
  })

  it.each([
    ['blockedBy', 'planning', (item: PipelineItem | undefined) => item?.blockers?.ok, false],
    ['comments', 'needs you', (item: PipelineItem | undefined) => item?.blockerComments, null],
    ['closedByPullRequestsReferences', 'implementing',(item: PipelineItem | undefined) => item?.closingPullRequests, null],
  ])('an own %s error is read as unreadable, and the half still succeeds', async (field, label, read, expected) => {
    const result = await issuesOf({
      issues: () => ok(issueSweepBody({ issues: connection([node(1, [label])]) })),
      issueDetails: () => ok({ data: { repository: { d0: { ...empty, [field]: null } }, rateLimit: RATE_LIMIT_REPLY }, errors: [{ type: 'SOME_ERROR', path: ['repository', 'd0', field], message: 'boom' }] }),
    }).read
    expect(result.ok && read(result.swept[0])).toBe(expected)
  })

  it.each([
    ['a failed call', () => httpFail('network', 502), 'network'],
    ['an error on any other field', () => ok({ data: { repository: { d0: { timelineItems: null } }, rateLimit: RATE_LIMIT_REPLY }, errors: [{ type: 'SOME_ERROR', path: ['repository', 'd0', 'timelineItems'], message: 'boom' }] }), 'no-data'],
    ['a null node with no error', () => ok({ data: { repository: { d0: null }, rateLimit: RATE_LIMIT_REPLY } }), 'no-data'],
  ])('%s fails the half', async (_label, reply, kind) => {
    const result = await issuesOf({ issues: () => ok(issueSweepBody({ issues: connection([node(1, ['planning'])]) })), issueDetails: reply }).read
    expect(!result.ok && result.kind).toBe(kind)
  })

  it('sums the cost of every round trip and keeps the last reply\'s budget', async () => {
    const result = await issuesOf({
      issues: () => ok(issueSweepBody({ issues: connection([node(1, ['planning'])]), rateLimit: { cost: 2, remaining: 4990, resetAt: 'a', limit: 5000 } })),
      issueDetails: (document) => emptyDetails(document, { cost: 3, remaining: 4987, resetAt: 'b', limit: 5000 }),
    }).read
    expect(result.ok && result.rateLimit).toEqual({ cost: 5, remaining: 4987, resetAt: 'b', limit: 5000 })
  })
})

describe('readBoardIssues — tracked', () => {
  const PLAN: TrackedRef = { kind: 'issue', number: 3 }
  const missing = { trackedIssues: (): ReturnType<typeof ok> => ok({ data: { repository: { t0: node(3, []) }, rateLimit: RATE_LIMIT_REPLY } }) }

  it('drops a swept issue the store does not track and keeps the tracked one', async () => {
    const { board, read } = issuesOf({ issues: () => ok(issueSweepBody({ issues: connection([node(1, ['planning']), node(3, ['planning'])]) })) }, [PLAN])
    const result = await read
    expect(result.ok && result.swept.map((item) => [item.number, item.matchedKeys])).toEqual([[3, ['planning']]])
    expect(board.documents.some((document) => document.includes('t0:'))).toBe(false)
  })

  it('reads a tracked issue whose labels were all removed by number', async () => {
    const { board, read } = issuesOf(missing, [PLAN])
    const result = await read
    expect(result.ok && result.read[0]).toMatchObject({ number: 3, kind: 'issue', matchedKeys: [] })
    expect(board.documents.find((document) => document.includes('t0:'))).toContain('t0: issue(number: 3)')
  })

  it('reports a non-open tracked issue as closed rather than as an item', async () => {
    const result = await issuesOf({ trackedIssues: () => ok({ data: { repository: { t0: node(3, ['planning'], { state: 'CLOSED' }) }, rateLimit: RATE_LIMIT_REPLY } }) }, [PLAN]).read
    expect(result.ok && [result.read, result.closed]).toEqual([[], [3]])
  })

  it.each([
    ['NOT_FOUND', 'NOT_FOUND', true],
    ['any other error', 'FORBIDDEN', false],
  ])('a tracked alias erroring with %s', async (_label, type, closed) => {
    const result = await issuesOf({ trackedIssues: () => ok({ data: { repository: { t0: null }, rateLimit: RATE_LIMIT_REPLY }, errors: [{ type, path: ['repository', 't0'], message: 'x' }] }) }, [PLAN]).read
    expect(result.ok).toBe(closed)
    expect(result.ok && result.closed).toEqual(closed ? [3] : false)
  })
})
