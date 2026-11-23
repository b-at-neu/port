import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { GitHubHttpResult, GitHubTransport } from '@/types/platform'
import type { PipelineItem, RateLimitInfo } from '@/types/github'
import type { TrackedRef } from '@/types/pipeline-state'
import type { BoardIssuesRead, Tracker } from '@/types/tracker'
import { readBoard } from '@/main/state/board-read'
import { RATE_LIMIT_REPLY, connection } from '../../../fixtures/pipeline-reply'
import { httpFail, httpOk, queryOf } from '../../../fixtures/github-http'

const REPO = { owner: 'o', name: 'r' }
const VOCABULARY = resolveVocabulary({})
const NOW = (): Date => new Date('2026-01-01T00:00:00Z')

function item(kind: 'issue' | 'pull-request', number: number): PipelineItem {
  return {
    repo: 'o/r',
    kind,
    number,
    title: `${kind} ${number}`,
    url: '',
    body: '',
    state: 'OPEN',
    mergedAt: null,
    updatedAt: null,
    assignees: [],
    labels: [],
    matchedKeys: [],
    labelEvents: [],
    headRefOid: null,
    mergeable: null,
    reviews: null,
    comments: null,
    checkRollup: null,
    blockers: null,
    blockerComments: null,
    closingPullRequests: null,
  }
}

function issuesRead(overrides: Partial<Extract<BoardIssuesRead, { ok: true }>> = {}): BoardIssuesRead {
  return { ok: true, swept: [], tracked: [], closed: [], viewer: 'op', repoLabels: { ok: true, names: VOCABULARY.labels.map((label) => label.name) }, unavailable: [], truncated: [], rateLimit: { ...RATE_LIMIT_REPLY, cost: 2 }, ...overrides }
}

function trackerReading(read: BoardIssuesRead): Tracker {
  const unused = (): never => {
    throw new Error('not used by the board read')
  }
  return {
    readBoardIssues: () => Promise.resolve(read),
    precheck: unused,
    forget: unused,
    readItemsByNumber: unused,
    readItemStates: unused,
    readClaimPreflight: unused,
    readGatePreflight: unused,
    listBacklog: unused,
    readTicket: unused,
    readLedger: unused,
    postPlanBody: unused,
  }
}

function ok(body: unknown): GitHubHttpResult {
  return httpOk(JSON.stringify(body))
}

function pullNode(number: number, state = 'OPEN', mergedAt: string | null = null): Record<string, unknown> {
  return { number, title: `pr ${number}`, url: '', body: '', state, mergedAt, assignees: { nodes: [] }, labels: { nodes: [{ name: 'ready for review' }] } }
}

interface PullScript {
  readonly swept?: readonly unknown[]
  readonly tracked?: Record<string, unknown>
  readonly rateLimit?: RateLimitInfo
}

/** Answers the pull-request half: the sweep, the tracked read by number, and one empty detail per alias. */
function pullTransport(script: PullScript = {}): GitHubTransport {
  const rateLimit = script.rateLimit ?? { ...RATE_LIMIT_REPLY, cost: 3 }
  return (request) => {
    const document = queryOf(request)
    if (document.includes('t0:')) return Promise.resolve(ok({ data: { repository: script.tracked ?? {}, rateLimit } }))
    if (document.includes('d0:')) {
      const repository: Record<string, unknown> = {}
      for (const match of document.matchAll(/d(\d+): pullRequest\(/g)) repository[`d${match[1]}`] = { timelineItems: { nodes: [] }, reviews: { nodes: [] }, comments: { nodes: [] } }
      return Promise.resolve(ok({ data: { repository, rateLimit } }))
    }
    return Promise.resolve(ok({ data: { repository: { pullRequests: connection(script.swept ?? []), integrationHistory: null }, rateLimit } }))
  }
}

describe('readBoard', () => {
  it('merges the halves in today\'s order: swept issues, swept pull requests, then tracked items in ref order', async () => {
    const refs: TrackedRef[] = [
      { kind: 'pull-request', number: 40, keys: ['marker', 'approved'] },
      { kind: 'issue', number: 30, keys: ['marker', 'planReview'] },
      { kind: 'issue', number: 10, keys: ['marker', 'ready'] },
      { kind: 'pull-request', number: 20, keys: ['marker', 'readyForReview'] },
    ]
    const tracker = trackerReading(issuesRead({ swept: [item('issue', 10)], tracked: [item('issue', 30)] }))
    const github = pullTransport({ swept: [pullNode(20)], tracked: { t0: pullNode(40) } })
    const result = await readBoard({ tracker, repo: REPO, vocabulary: VOCABULARY, integration: 'dev', tracked: refs, github, now: NOW })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items.map((entry) => `${entry.kind}:${String(entry.number)}`)).toEqual(['issue:10', 'pull-request:20', 'pull-request:40', 'issue:30'])
    expect(result.viewer).toBe('op')
    expect(result.fetchedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('orders closed by the store\'s refs and takes merged from the pull-request half', async () => {
    const refs: TrackedRef[] = [
      { kind: 'issue', number: 3, keys: ['marker'] },
      { kind: 'pull-request', number: 9, keys: ['marker', 'approved'] },
      { kind: 'pull-request', number: 10, keys: ['marker', 'readyForReview'] },
    ]
    const tracker = trackerReading(issuesRead({ closed: [3] }))
    const github = pullTransport({ tracked: { t0: pullNode(9, 'MERGED', '2026-01-01T00:00:00Z'), t1: pullNode(10, 'CLOSED') } })
    const result = await readBoard({ tracker, repo: REPO, vocabulary: VOCABULARY, integration: 'dev', tracked: refs, github, now: NOW })
    expect(result.ok && result.closed).toEqual([3, 9, 10])
    expect(result.ok && result.merged).toEqual([9])
  })

  it('reads the label path as the swept items alone, closed and merged empty', async () => {
    const tracker = trackerReading(issuesRead({ swept: [item('issue', 1)] }))
    const result = await readBoard({ tracker, repo: REPO, vocabulary: VOCABULARY, integration: 'dev', tracked: null, github: pullTransport({ swept: [pullNode(2)] }), now: NOW })
    expect(result.ok && result.items.map((entry) => entry.number)).toEqual([1, 2])
    expect(result.ok && result.closed).toEqual([])
    expect(result.ok && result.merged).toEqual([])
  })

  it('fails the read when the issue half fails, never merging it as empty', async () => {
    const tracker = trackerReading({ ok: false, kind: 'network', message: 'issues down' })
    const result = await readBoard({ tracker, repo: REPO, vocabulary: VOCABULARY, integration: 'dev', github: pullTransport(), now: NOW })
    expect(result).toMatchObject({ ok: false, kind: 'network', message: 'issues down' })
  })

  it('fails the read when the pull-request half fails, never merging it as empty', async () => {
    const result = await readBoard({ tracker: trackerReading(issuesRead()), repo: REPO, vocabulary: VOCABULARY, integration: 'dev', github: () => Promise.resolve(httpFail('network', 503)), now: NOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('network')
    expect('items' in result).toBe(false)
  })

  it('a rate-limited failure wins over the other half\'s, so the scheduler still defers to resetAt', async () => {
    const tracker = trackerReading({ ok: false, kind: 'network', message: 'issues down' })
    const limited = await readBoard({ tracker, repo: REPO, vocabulary: VOCABULARY, integration: 'dev', github: () => Promise.resolve(httpFail('rate-limited', 403, 'API rate limit exceeded')), now: NOW })
    expect(limited).toMatchObject({ ok: false, kind: 'rate-limited' })

    const limitedIssues = trackerReading({ ok: false, kind: 'rate-limited', message: 'slow down' })
    const other = await readBoard({ tracker: limitedIssues, repo: REPO, vocabulary: VOCABULARY, integration: 'dev', github: () => Promise.resolve(httpFail('network', 503)), now: NOW })
    expect(other).toMatchObject({ ok: false, kind: 'rate-limited', message: 'slow down' })
  })

  it('sums the cost of both halves and keeps the budget of the half with the lower remaining', async () => {
    const tracker = trackerReading(issuesRead({ rateLimit: { cost: 2, remaining: 4000, resetAt: '2026-01-01T00:30:00Z', limit: 5000 } }))
    const github = pullTransport({ rateLimit: { cost: 3, remaining: 3990, resetAt: '2026-01-01T00:31:00Z', limit: 5000 } })
    const result = await readBoard({ tracker, repo: REPO, vocabulary: VOCABULARY, integration: 'dev', github, now: NOW })
    expect(result.ok && result.rateLimit).toEqual({ cost: 5, remaining: 3990, resetAt: '2026-01-01T00:31:00Z', limit: 5000 })
  })

  it('lists the issue half\'s unavailable and truncated sets before the pull-request half\'s', async () => {
    const tracker = trackerReading(issuesRead({ unavailable: [{ alias: 'issues', surface: 'issue' }], truncated: [{ alias: 'issues', surface: 'issue', totalCount: 9, received: 3 }] }))
    const github: GitHubTransport = () => Promise.resolve(ok({ data: { repository: { integrationHistory: null }, rateLimit: RATE_LIMIT_REPLY } }))
    const result = await readBoard({ tracker, repo: REPO, vocabulary: VOCABULARY, integration: 'dev', github, now: NOW })
    expect(result.ok && result.unavailable).toEqual([
      { alias: 'issues', surface: 'issue' },
      { alias: 'pullRequests', surface: 'pull-request' },
    ])
    expect(result.ok && result.truncated).toEqual([{ alias: 'issues', surface: 'issue', totalCount: 9, received: 3 }])
  })
})
