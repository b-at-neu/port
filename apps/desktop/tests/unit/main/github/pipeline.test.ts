import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { LabelVocabulary } from '@/utils/labels/vocabulary'
import type { GitHubHttpResult, GitHubTransport } from '@/types/platform'
import type { TrackedRef } from '@/types/pipeline-state'
import { readBoardPullRequests } from '@/main/github/pipeline'
import { RATE_LIMIT_REPLY, connection } from '../../../fixtures/pipeline-reply'
import { httpFail, httpOk, queryOf } from '../../../fixtures/github-http'

const REPO = { owner: 'o', name: 'r' }
const VOCABULARY = resolveVocabulary({})

function ok(body: unknown): GitHubHttpResult {
  return httpOk(JSON.stringify(body))
}

function node(number: number, labels: readonly string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { number, title: `pr ${number}`, url: `https://github.com/o/r/pull/${number}`, body: '', state: 'OPEN', mergedAt: null, assignees: { nodes: [] }, labels: { nodes: labels.map((name) => ({ name })) }, ...extra }
}

/** The integration branch's history alias, `commits` being each commit's rollup contexts. */
function history(commits: readonly (readonly unknown[])[]): unknown {
  return { target: { history: { nodes: commits.map((contexts) => ({ oid: 'abc', statusCheckRollup: { contexts: { nodes: contexts } } })) } } }
}

interface SweepBody {
  readonly pullRequests?: unknown
  readonly integrationHistory?: unknown
  readonly rateLimit?: unknown
}

function sweepBody(body: SweepBody): Record<string, unknown> {
  const repository: Record<string, unknown> = {}
  if (body.pullRequests !== undefined) repository.pullRequests = body.pullRequests
  if (body.integrationHistory !== undefined) repository.integrationHistory = body.integrationHistory
  return { data: { repository, rateLimit: body.rateLimit ?? RATE_LIMIT_REPLY } }
}

const ALIAS_PATTERN = /d(\d+): pullRequest\(number: (\d+)\)/g

/** One empty detail node per alias the document asks for. */
function emptyDetails(document: string, rateLimit: unknown = RATE_LIMIT_REPLY): GitHubHttpResult {
  const repository: Record<string, unknown> = {}
  for (const match of document.matchAll(ALIAS_PATTERN)) repository[`d${match[1]}`] = { timelineItems: { nodes: [] }, reviews: { nodes: [] }, comments: { nodes: [] } }
  return ok({ data: { repository, rateLimit } })
}

interface Script {
  readonly sweep: (document: string, call: number) => GitHubHttpResult
  readonly details?: (document: string) => GitHubHttpResult
  readonly tracked?: (document: string) => GitHubHttpResult
}

function scripted(script: Script): { readonly runner: GitHubTransport; readonly documents: string[] } {
  const documents: string[] = []
  let sweeps = 0
  const runner: GitHubTransport = (request) => {
    const document = queryOf(request)
    documents.push(document)
    if (document.includes('t0:')) return Promise.resolve((script.tracked ?? (() => ok({ data: { repository: {}, rateLimit: RATE_LIMIT_REPLY } })))(document))
    if (document.includes('d0:')) return Promise.resolve((script.details ?? ((detailDocument) => emptyDetails(detailDocument)))(document))
    return Promise.resolve(script.sweep(document, sweeps++))
  }
  return { runner, documents }
}

function readWith(runner: GitHubTransport, vocabulary: LabelVocabulary = VOCABULARY, tracked: readonly TrackedRef[] | null = null) {
  return readBoardPullRequests({ repo: REPO, vocabulary, tracked, integration: 'dev', github: runner })
}

describe('readBoardPullRequests', () => {
  it('a full success reads the integration history on the first page, so the whole read is two round trips', async () => {
    const { runner, documents } = scripted({ sweep: () => ok(sweepBody({ pullRequests: connection([node(5, ['ready for review'])]), integrationHistory: history([]) })) })
    const result = await readWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.swept).toHaveLength(1)
    expect(result.swept[0]?.matchedKeys).toEqual(['readyForReview'])
    expect(result.tracked).toEqual([])
    expect(result.rateLimit).toEqual({ ...RATE_LIMIT_REPLY, cost: 2 })
    expect(result.unavailable).toEqual([])
    expect(result.truncated).toEqual([])
    expect(documents).toHaveLength(2)
    expect(documents[0]).toContain('integrationHistory:')
  })

  it('asks for no details when the sweep is empty', async () => {
    const { runner, documents } = scripted({ sweep: () => ok(sweepBody({ pullRequests: connection([]) })) })
    const result = await readWith(runner)
    expect(result.ok && result.swept).toEqual([])
    expect(documents).toHaveLength(1)
  })

  it('with no enabled label page one still runs for the integration history, and no connection is asked', async () => {
    const { runner, documents } = scripted({ sweep: () => ok(sweepBody({ integrationHistory: history([[{ __typename: 'CheckRun', name: 't', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-01-01T00:00:00Z' }]]) })) })
    const result = await readWith(runner, { labels: [], disabled: [], problems: [] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.swept).toEqual([])
    expect(result.integrationChecks).toEqual({ t: 'red' })
    expect(documents[0]).not.toContain('pullRequests(')
    expect(documents).toHaveLength(1)
  })

  it('follows a second page carrying the cursor, without re-reading the integration history', async () => {
    const { runner, documents } = scripted({
      sweep: (_document, call) =>
        call === 0
          ? ok(sweepBody({ pullRequests: connection([node(5, ['ready for review'])], { hasNextPage: true, endCursor: 'cursor-1' }, 2), integrationHistory: history([]) }))
          : ok(sweepBody({ pullRequests: connection([node(6, ['ready for review'])], { hasNextPage: false, endCursor: null }, 2) })),
    })
    const result = await readWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.swept.map((item) => item.number)).toEqual([5, 6])
    expect(documents[1]).toContain('after: "cursor-1"')
    expect(documents[1]).not.toContain('integrationHistory')
  })

  it('stops at the page cap and reports that the pull requests still had pages', async () => {
    let next = 0
    const { runner, documents } = scripted({
      sweep: () => ok(sweepBody({ pullRequests: connection([node(++next, ['ready for review'])], { hasNextPage: true, endCursor: `cursor-${next}` }, 5000) })),
    })
    const result = await readWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(documents.filter((document) => !document.includes('d0:'))).toHaveLength(10)
    expect(result.truncated).toEqual([{ alias: 'pullRequests', surface: 'pull-request', totalCount: 5000, received: 10 }])
    expect(result.swept).toHaveLength(10)
  })

  it('a failure on a later page fails the whole read, never a short list', async () => {
    const { runner } = scripted({
      sweep: (_document, call) => (call === 0 ? ok(sweepBody({ pullRequests: connection([node(5, ['ready for review'])], { hasNextPage: true, endCursor: 'cursor-1' }, 2) })) : httpFail('network', 502)),
    })
    const result = await readWith(runner)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('network')
    expect('swept' in result).toBe(false)
  })

  it('the pullRequests connection named in errors is unavailable and its items dropped', async () => {
    const { runner } = scripted({
      sweep: () => ok({ ...sweepBody({ pullRequests: null }), errors: [{ type: 'SOME_ERROR', path: ['repository', 'pullRequests'], message: 'boom' }] }),
    })
    const result = await readWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.swept).toEqual([])
    expect(result.unavailable).toEqual([{ alias: 'pullRequests', surface: 'pull-request' }])
  })

  it('the pullRequests connection missing from the reply without an error is unavailable, never read as empty', async () => {
    const { runner } = scripted({ sweep: () => ok(sweepBody({})) })
    const result = await readWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.unavailable).toEqual([{ alias: 'pullRequests', surface: 'pull-request' }])
  })

  it.each([
    ['unauthenticated', httpFail('unauthenticated', 401)],
    ['rate-limited', httpFail('rate-limited', 403, 'API rate limit exceeded')],
    ['network', httpFail('network', 503)],
  ])('%s returns ok: false with no swept field, not an empty list', async (_label, failure) => {
    const result = await readWith(() => Promise.resolve(failure))
    expect(result.ok).toBe(false)
    expect('swept' in result).toBe(false)
  })
})

describe('readBoardPullRequests — integration history', () => {
  const build = (conclusion: string, startedAt: string): unknown => ({ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion, startedAt })

  it('reduces the history, newest commit first, to its latest concluded status per check', async () => {
    const { runner, documents } = scripted({
      sweep: () =>
        ok(
          sweepBody({
            pullRequests: connection([]),
            integrationHistory: history([[build('FAILURE', '2026-01-02T00:00:00Z')], [build('SUCCESS', '2026-01-01T00:00:00Z'), { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS', createdAt: '2026-01-01T00:00:00Z' }]]),
          }),
        ),
    })
    const result = await readWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.integrationChecks).toEqual({ test: 'red', 'ci/legacy': 'green' })
    expect(documents[0]).toContain('refs/heads/dev')
  })

  it('an errored integration alias is unreadable, never an empty record, and never fails the read', async () => {
    const { runner } = scripted({
      sweep: () => ok({ ...sweepBody({ pullRequests: connection([]), integrationHistory: null }), errors: [{ message: 'not found', path: ['repository', 'integrationHistory'] }] }),
    })
    const result = await readWith(runner)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.integrationChecks).toBeNull()
  })

  it('a missing integration alias is unreadable too', async () => {
    const { runner } = scripted({ sweep: () => ok(sweepBody({ pullRequests: connection([]) })) })
    const result = await readWith(runner)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.integrationChecks).toBeNull()
  })
})

describe('readBoardPullRequests — details', () => {
  const approvedPull = node(2, ['approved'])
  const reviewPull = node(3, ['ready for review'])
  const sweep = (): GitHubHttpResult => ok(sweepBody({ pullRequests: connection([approvedPull, reviewPull]) }))

  it('merges each detail onto its pull request, spreading the rollup on each at the approved or ready-for-review stage', async () => {
    const rollup = { commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [{ __typename: 'CheckRun', name: 'build', conclusion: 'FAILURE', status: 'COMPLETED' }] } } } }] } }
    const { runner, documents } = scripted({
      sweep,
      details: () =>
        ok({
          data: {
            repository: {
              d0: { timelineItems: { nodes: [] }, reviews: { nodes: [{ body: '## Code Review — Cycle 1', submittedAt: '2026-01-01T00:00:00Z', commit: { oid: 'sha' } }] }, comments: { nodes: [] }, ...rollup },
              d1: { timelineItems: { nodes: [] }, reviews: { nodes: [] }, comments: { nodes: [] }, ...rollup },
            },
            rateLimit: RATE_LIMIT_REPLY,
          },
        }),
    })
    const result = await readWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.swept[0]?.reviews).toHaveLength(1)
    expect(result.swept[0]?.checkRollup?.map((check) => check.name)).toEqual(['build'])
    expect(result.swept[1]?.reviews).toEqual([])
    expect(result.swept[1]?.blockers).toBeNull()
    expect((documents[1] ?? '').split('...CheckRollupFields')).toHaveLength(3)
  })

  it('sums the cost of every round trip and keeps the last reply\'s budget', async () => {
    const { runner } = scripted({
      sweep: () => ok(sweepBody({ pullRequests: connection([reviewPull]), rateLimit: { cost: 2, remaining: 4990, resetAt: '2026-01-01T00:30:00Z', limit: 5000 } })),
      details: (document) => emptyDetails(document, { cost: 3, remaining: 4987, resetAt: '2026-01-01T00:31:00Z', limit: 5000 }),
    })
    const result = await readWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rateLimit).toEqual({ cost: 5, remaining: 4987, resetAt: '2026-01-01T00:31:00Z', limit: 5000 })
  })

  it('a failed detail call fails the whole read', async () => {
    const { runner } = scripted({ sweep, details: () => httpFail('network', 502) })
    const result = await readWith(runner)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('network')
  })

  it('a detail alias named in errors fails the whole read, naming the item', async () => {
    const { runner } = scripted({
      sweep,
      details: () =>
        ok({
          data: { repository: { d0: { timelineItems: { nodes: [] }, reviews: { nodes: [] }, comments: { nodes: [] } }, d1: null }, rateLimit: RATE_LIMIT_REPLY },
          errors: [{ type: 'SOME_ERROR', path: ['repository', 'd1'], message: 'boom' }],
        }),
    })
    const result = await readWith(runner)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('no-data')
    expect(result.message).toContain('#3')
  })

  it('a pull request alias comments error still fails the whole read', async () => {
    const { runner } = scripted({
      sweep,
      details: () =>
        ok({
          data: { repository: { d0: { timelineItems: { nodes: [] }, reviews: { nodes: [] }, comments: null }, d1: { timelineItems: { nodes: [] }, reviews: { nodes: [] }, comments: { nodes: [] } } }, rateLimit: RATE_LIMIT_REPLY },
          errors: [{ type: 'SOME_ERROR', path: ['repository', 'd0', 'comments'], message: 'boom' }],
        }),
    })
    const result = await readWith(runner)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('#2')
  })

  it('a detail alias that comes back null, with no error entry, fails the whole read too', async () => {
    const { runner } = scripted({
      sweep,
      details: () => ok({ data: { repository: { d0: { timelineItems: { nodes: [] } }, d1: null }, rateLimit: RATE_LIMIT_REPLY } }),
    })
    const result = await readWith(runner)
    expect(result.ok).toBe(false)
  })
})

const TRACKED_APPROVED: TrackedRef = { kind: 'pull-request', number: 9, keys: ['marker', 'approved'] }
const TRACKED_REVIEW: TrackedRef = { kind: 'pull-request', number: 10, keys: ['marker', 'readyForReview'] }

describe('readBoardPullRequests — tracked pull requests', () => {
  it('reports nothing closed or merged on the label path', async () => {
    const { runner, documents } = scripted({ sweep: () => ok(sweepBody({ pullRequests: connection([node(5, ['ready for review'])]) })) })
    const result = await readWith(runner, VOCABULARY, null)
    expect(result.ok && result.closed).toEqual([])
    expect(result.ok && result.merged).toEqual([])
    expect(documents.some((document) => document.includes('t0:'))).toBe(false)
  })

  it('drops a swept pull request the store does not track, and keeps the store\'s keys on one it does', async () => {
    const { runner, documents } = scripted({ sweep: () => ok(sweepBody({ pullRequests: connection([node(5, ['ready for review']), node(9, ['ready for review'])]) })) })
    const result = await readWith(runner, VOCABULARY, [TRACKED_APPROVED])
    expect(result.ok && result.swept.map((item) => [item.number, item.matchedKeys])).toEqual([[9, ['marker', 'approved']]])
    expect(documents.some((document) => document.includes('t0:'))).toBe(false)
  })

  it('fetches a tracked pull request whose labels were removed, by number, and returns it apart from the swept ones', async () => {
    const { runner, documents } = scripted({
      sweep: () => ok(sweepBody({ pullRequests: connection([]) })),
      tracked: () => ok({ data: { repository: { t0: node(9, []) }, rateLimit: RATE_LIMIT_REPLY } }),
    })
    const result = await readWith(runner, VOCABULARY, [TRACKED_APPROVED])
    expect(result.ok && result.swept).toEqual([])
    expect(result.ok && result.tracked[0]).toMatchObject({ number: 9, kind: 'pull-request', matchedKeys: ['marker', 'approved'] })
    expect(documents.find((document) => document.includes('t0:'))).toContain('t0: pullRequest(number: 9)')
  })

  it('reports a merged tracked pull request in merged as well as closed, and an unmerged close in closed only', async () => {
    const { runner } = scripted({
      sweep: () => ok(sweepBody({ pullRequests: connection([]) })),
      tracked: () =>
        ok({
          data: {
            repository: { t0: node(9, ['approved'], { state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z' }), t1: node(10, ['ready for review'], { state: 'CLOSED' }) },
            rateLimit: RATE_LIMIT_REPLY,
          },
        }),
    })
    const result = await readWith(runner, VOCABULARY, [TRACKED_APPROVED, TRACKED_REVIEW])
    expect(result.ok && result.closed).toEqual([9, 10])
    expect(result.ok && result.merged).toEqual([9])
  })

  it('reports a pull request GitHub no longer has as closed', async () => {
    const { runner } = scripted({
      sweep: () => ok(sweepBody({ pullRequests: connection([]) })),
      tracked: () => ok({ data: { repository: { t0: null }, rateLimit: RATE_LIMIT_REPLY }, errors: [{ type: 'NOT_FOUND', path: ['repository', 't0'], message: 'gone' }] }),
    })
    const result = await readWith(runner, VOCABULARY, [TRACKED_APPROVED])
    expect(result.ok && result.closed).toEqual([9])
  })

  it('fails the whole read when a tracked alias errors for any other reason, never reading it as closed', async () => {
    const { runner } = scripted({
      sweep: () => ok(sweepBody({ pullRequests: connection([]) })),
      tracked: () => ok({ data: { repository: { t0: null }, rateLimit: RATE_LIMIT_REPLY }, errors: [{ type: 'FORBIDDEN', path: ['repository', 't0'], message: 'no' }] }),
    })
    const result = await readWith(runner, VOCABULARY, [TRACKED_APPROVED])
    expect(result.ok).toBe(false)
  })
})
