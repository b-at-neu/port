import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { LabelVocabulary } from '@/utils/labels/vocabulary'
import type { GitHubHttpResult, GitHubTransport } from '@/types/platform'
import type { TrackedRef } from '@/types/pipeline-state'
import { readBoardIssues } from '@/main/github/tracker/board'
import { RATE_LIMIT_REPLY, connection } from '../../../../fixtures/pipeline-reply'
import { httpFail, httpOk, queryOf } from '../../../../fixtures/github-http'

const REPO = { owner: 'o', name: 'r' }
const VOCABULARY = resolveVocabulary({})
const REPO_LABELS_OK = { totalCount: VOCABULARY.labels.length, nodes: VOCABULARY.labels.map((label) => ({ name: label.name })) }

function ok(body: unknown): GitHubHttpResult {
  return httpOk(JSON.stringify(body))
}

// A partial GraphQL reply is a 200 whose body carries `errors` beside usable data.
const partial = ok

function node(number: number, labels: readonly string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { number, title: `item ${number}`, url: `https://github.com/o/r/issues/${number}`, body: '', state: 'OPEN', assignees: { nodes: [] }, labels: { nodes: labels.map((name) => ({ name })) }, ...extra }
}

interface SweepBody {
  readonly issues?: unknown
  readonly rateLimit?: unknown
  readonly viewer?: unknown
  readonly repoLabels?: unknown
}

function sweepBody(body: SweepBody): Record<string, unknown> {
  const repository: Record<string, unknown> = { repoLabels: body.repoLabels ?? REPO_LABELS_OK }
  if (body.issues !== undefined) repository.issues = body.issues
  return { data: { repository, rateLimit: body.rateLimit ?? RATE_LIMIT_REPLY, ...(body.viewer !== undefined ? { viewer: body.viewer } : {}) } }
}

const ALIAS_PATTERN = /d(\d+): issue\(number: (\d+)\)/g

/** One empty detail node per alias the document asks for. */
function emptyDetails(document: string, rateLimit: unknown = RATE_LIMIT_REPLY): GitHubHttpResult {
  const repository: Record<string, unknown> = {}
  for (const match of document.matchAll(ALIAS_PATTERN)) repository[`d${match[1]}`] = { timelineItems: { nodes: [] }, blockedBy: { totalCount: 0, nodes: [] } }
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
  return readBoardIssues({ repo: REPO, vocabulary, tracked, github: runner })
}

describe('readBoardIssues', () => {
  it('a full success', async () => {
    const { runner, documents } = scripted({ sweep: () => ok(sweepBody({ issues: connection([node(1, ['ready'])]), viewer: { login: 'op' } })) })
    const result = await readWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.swept).toHaveLength(1)
    expect(result.swept[0]?.matchedKeys).toEqual(['ready'])
    expect(result.tracked).toEqual([])
    expect(result.repoLabels).toEqual({ ok: true, names: VOCABULARY.labels.map((label) => label.name) })
    expect(result.viewer).toBe('op')
    expect(result.rateLimit).toEqual({ ...RATE_LIMIT_REPLY, cost: 2 })
    expect(result.unavailable).toEqual([])
    expect(result.truncated).toEqual([])
    expect(documents).toHaveLength(2)
  })

  it('an item with two vocabulary labels and a non-vocabulary label is one item with two keys', async () => {
    const labels = ['ready', 'bug', 'in progress']
    const { runner } = scripted({ sweep: () => ok(sweepBody({ issues: connection([node(1, labels)]) })) })
    const result = await readWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.swept).toHaveLength(1)
    expect(result.swept[0]?.matchedKeys).toEqual(VOCABULARY.labels.map((label) => label.key).filter((key) => key === 'ready' || key === 'inProgress'))
    expect(result.swept[0]?.labels).toEqual(labels)
  })

  it('asks for no details when the sweep is empty', async () => {
    const { runner, documents } = scripted({ sweep: () => ok(sweepBody({ issues: connection([]) })) })
    const result = await readWith(runner)
    expect(result.ok && result.swept).toEqual([])
    expect(documents).toHaveLength(1)
  })

  it('with no enabled label page one still runs, so the viewer and the repository labels are read, and no connection is asked', async () => {
    const { runner, documents } = scripted({ sweep: () => ok(sweepBody({ viewer: { login: 'op' } })) })
    const result = await readWith(runner, { labels: [], disabled: [], problems: [] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.swept).toEqual([])
    expect(result.viewer).toBe('op')
    expect(result.repoLabels.ok).toBe(true)
    expect(documents[0]).not.toContain('issues(')
    expect(documents).toHaveLength(1)
  })

  it('follows a second page carrying the cursor', async () => {
    const { runner, documents } = scripted({
      sweep: (_document, call) =>
        call === 0
          ? ok(sweepBody({ issues: connection([node(1, ['ready'])], { hasNextPage: true, endCursor: 'cursor-1' }, 2) }))
          : ok(sweepBody({ issues: connection([node(2, ['ready'])], { hasNextPage: false, endCursor: null }, 2) })),
    })
    const result = await readWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.swept.map((item) => item.number)).toEqual([1, 2])
    expect(documents[1]).toContain('after: "cursor-1"')
    expect(documents[1]).not.toContain('repoLabels')
    expect(result.truncated).toEqual([])
  })

  it('stops at the page cap and reports that the issues still had pages', async () => {
    let next = 0
    const { runner, documents } = scripted({
      sweep: () => ok(sweepBody({ issues: connection([node(++next, ['ready'])], { hasNextPage: true, endCursor: `cursor-${next}` }, 5000) })),
    })
    const result = await readWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(documents.filter((document) => !document.includes('d0:'))).toHaveLength(10)
    expect(result.truncated).toEqual([{ alias: 'issues', surface: 'issue', totalCount: 5000, received: 10 }])
    expect(result.swept).toHaveLength(10)
  })

  it('a failure on a later page fails the whole read, never a short list', async () => {
    const { runner } = scripted({
      sweep: (_document, call) => (call === 0 ? ok(sweepBody({ issues: connection([node(1, ['ready'])], { hasNextPage: true, endCursor: 'cursor-1' }, 2) })) : httpFail('network', 502)),
    })
    const result = await readWith(runner)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('network')
    expect('swept' in result).toBe(false)
  })

  it('the issues connection named in errors is unavailable and its items dropped', async () => {
    const { runner } = scripted({
      sweep: () => partial({ ...sweepBody({ issues: null }), errors: [{ type: 'SOME_ERROR', path: ['repository', 'issues'], message: 'boom' }] }),
    })
    const result = await readWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.swept).toEqual([])
    expect(result.unavailable).toEqual([{ alias: 'issues', surface: 'issue' }])
  })

  it('the issues connection missing from the reply without an error is unavailable, never read as empty', async () => {
    const { runner } = scripted({ sweep: () => ok(sweepBody({})) })
    const result = await readWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.unavailable).toEqual([{ alias: 'issues', surface: 'issue' }])
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

  it('a >100-label repository reports its label list unverified, never confidently short', async () => {
    const nodes = Array.from({ length: 100 }, (_, i) => ({ name: `label-${i}` }))
    const { runner } = scripted({ sweep: () => ok(sweepBody({ issues: connection([]), repoLabels: { totalCount: 150, nodes } })) })
    const result = await readWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repoLabels).toEqual({ ok: false, reason: 'label list truncated at 100 of 150' })
  })

  // viewer resolves when present, and is null (never a guess) when the alias is absent or dropped.
  it.each([
    ['present', { login: 'op' }, false, 'op'],
    ['absent', undefined, false, null],
    ['errored', null, true, null],
  ] as const)('viewer: %s → %s', async (_label, viewer, erroredOut, expected) => {
    const body: Record<string, unknown> = sweepBody({ issues: connection([]), viewer })
    if (erroredOut) body.errors = [{ type: 'SOME_ERROR', path: ['viewer'], message: 'boom' }]
    const result = await readWith(() => Promise.resolve(erroredOut ? partial(body) : ok(body)))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.viewer).toBe(expected)
  })
})

describe('readBoardIssues — details', () => {
  const issue = node(1, ['ready'])
  const sweep = (): GitHubHttpResult => ok(sweepBody({ issues: connection([issue, node(2, ['ready'])]) }))

  it('merges each detail onto its issue', async () => {
    const { runner } = scripted({
      sweep,
      details: () =>
        ok({
          data: {
            repository: {
              d0: { timelineItems: { nodes: [{ createdAt: '2026-01-01T00:00:00Z', actor: { login: 'op' }, label: { name: 'ready' } }] }, blockedBy: { totalCount: 0, nodes: [] } },
              d1: { timelineItems: { nodes: [] }, blockedBy: { totalCount: 0, nodes: [] } },
            },
            rateLimit: RATE_LIMIT_REPLY,
          },
        }),
    })
    const result = await readWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.swept[0]?.labelEvents).toEqual([{ label: 'ready', actor: 'op', at: '2026-01-01T00:00:00Z' }])
    expect(result.swept[0]?.blockers).toEqual({ ok: true, open: [], shown: 0, total: 0 })
    expect(result.swept[0]?.reviews).toBeNull()
  })

  it('sums the cost of every round trip and keeps the last reply\'s budget', async () => {
    const { runner } = scripted({
      sweep: () => ok(sweepBody({ issues: connection([issue]), rateLimit: { cost: 2, remaining: 4990, resetAt: '2026-01-01T00:30:00Z', limit: 5000 } })),
      details: (document) => emptyDetails(document, { cost: 3, remaining: 4987, resetAt: '2026-01-01T00:31:00Z', limit: 5000 }),
    })
    const result = await readWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rateLimit).toEqual({ cost: 5, remaining: 4987, resetAt: '2026-01-01T00:31:00Z', limit: 5000 })
  })

  it('chunks the detail read at 100 aliases per round trip', async () => {
    const issues = Array.from({ length: 101 }, (_, i) => node(i + 1, ['ready']))
    const { runner, documents } = scripted({ sweep: () => ok(sweepBody({ issues: connection(issues) })) })
    const result = await readWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.swept).toHaveLength(101)
    const detailDocuments = documents.filter((document) => document.includes('d0:'))
    expect(detailDocuments).toHaveLength(2)
    expect(detailDocuments[1]).not.toContain('d1:')
  })

  it('a failed detail call fails the whole read, keeping the caller on its last good one', async () => {
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
        partial({
          data: { repository: { d0: { timelineItems: { nodes: [] } }, d1: null }, rateLimit: RATE_LIMIT_REPLY },
          errors: [{ type: 'SOME_ERROR', path: ['repository', 'd1'], message: 'boom' }],
        }),
    })
    const result = await readWith(runner)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('no-data')
    expect(result.message).toContain('#2')
  })

  it('an issue alias blockedBy error is that issue\'s unreadable blockers, and the read still succeeds', async () => {
    const { runner } = scripted({
      sweep,
      details: () =>
        partial({
          data: { repository: { d0: { timelineItems: { nodes: [] }, blockedBy: null }, d1: { timelineItems: { nodes: [] }, blockedBy: { totalCount: 0, nodes: [] } } }, rateLimit: RATE_LIMIT_REPLY },
          errors: [{ type: 'SOME_ERROR', path: ['repository', 'd0', 'blockedBy'], message: 'boom' }],
        }),
    })
    const result = await readWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.swept[0]?.blockers?.ok).toBe(false)
    expect(result.swept[1]?.blockers?.ok).toBe(true)
  })

  it('asks for comments only on a blocked issue, and maps them', async () => {
    const blocked = node(1, ['blocked'])
    const comment = { body: 'why', createdAt: '2026-01-01T00:00:00Z', url: 'https://x/c' }
    const { runner, documents } = scripted({
      sweep: () => ok(sweepBody({ issues: connection([blocked, node(4, ['ready'])]) })),
      details: () =>
        ok({
          data: { repository: { d0: { timelineItems: { nodes: [] }, blockedBy: { totalCount: 0, nodes: [] }, comments: { nodes: [comment] } }, d1: { timelineItems: { nodes: [] }, blockedBy: { totalCount: 0, nodes: [] } } }, rateLimit: RATE_LIMIT_REPLY },
        }),
    })
    const result = await readWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const detailDocument = documents.find((document) => document.includes('d0:')) ?? ''
    expect(detailDocument.split('\n').find((line) => line.includes('d0:'))).toContain('comments(last: 10)')
    expect(detailDocument.split('\n').find((line) => line.includes('d1:'))).not.toContain('comments')
    expect(result.swept[0]?.blockerComments).toEqual([comment])
    expect(result.swept[1]?.blockerComments).toBeNull()
  })

  it('an issue alias comments error leaves its blocker comments unread, and the read still succeeds', async () => {
    const { runner } = scripted({
      sweep: () => ok(sweepBody({ issues: connection([node(1, ['blocked'])]) })),
      details: () =>
        partial({
          data: { repository: { d0: { timelineItems: { nodes: [] }, blockedBy: { totalCount: 0, nodes: [] }, comments: null } }, rateLimit: RATE_LIMIT_REPLY },
          errors: [{ type: 'SOME_ERROR', path: ['repository', 'd0', 'comments'], message: 'boom' }],
        }),
    })
    const result = await readWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.swept[0]?.blockerComments).toBeNull()
  })

  it('asks for closing pull requests on pr opened, plan approved, in progress and blocked issues only, and maps them with their branch', async () => {
    const empty = { timelineItems: { nodes: [] }, blockedBy: { totalCount: 0, nodes: [] } }
    const closing = (nodes: readonly unknown[]) => ({ ...empty, closedByPullRequestsReferences: { nodes } })
    const { runner, documents } = scripted({
      sweep: () => ok(sweepBody({ issues: connection([node(1, ['pr opened']), node(2, ['plan approved']), node(3, ['in progress']), node(5, ['blocked']), node(4, ['ready'])]) })),
      details: () => ok({ data: { repository: { d0: closing([{ number: 9, state: 'MERGED' }]), d1: closing([{ number: 780, state: 'OPEN', headRefName: '2-the-fix' }]), d2: closing([]), d3: closing([]), d4: empty }, rateLimit: RATE_LIMIT_REPLY } }),
    })
    const result = await readWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const lines = (documents.find((document) => document.includes('d0:')) ?? '').split('\n')
    for (const alias of ['d0:', 'd1:', 'd2:', 'd3:']) expect(lines.find((line) => line.includes(alias))).toContain('closedByPullRequestsReferences')
    expect(lines.find((line) => line.includes('d4:'))).not.toContain('closedByPullRequestsReferences')
    expect(result.swept[0]?.closingPullRequests).toEqual([{ number: 9, state: 'MERGED', headRefName: null }])
    expect(result.swept[1]?.closingPullRequests).toEqual([{ number: 780, state: 'OPEN', headRefName: '2-the-fix' }])
    expect(result.swept[4]?.closingPullRequests).toBeNull()
  })

  it('a closedByPullRequestsReferences error leaves closing pull requests unread, and the read still succeeds', async () => {
    const { runner } = scripted({
      sweep: () => ok(sweepBody({ issues: connection([node(1, ['pr opened'])]) })),
      details: () =>
        partial({
          data: { repository: { d0: { timelineItems: { nodes: [] }, blockedBy: { totalCount: 0, nodes: [] }, closedByPullRequestsReferences: null } }, rateLimit: RATE_LIMIT_REPLY },
          errors: [{ type: 'SOME_ERROR', path: ['repository', 'd0', 'closedByPullRequestsReferences'], message: 'boom' }],
        }),
    })
    const result = await readWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.swept[0]?.closingPullRequests).toBeNull()
  })

  it('an issue alias error on any other field still fails the whole read', async () => {
    const { runner } = scripted({
      sweep,
      details: () =>
        partial({
          data: { repository: { d0: { timelineItems: null }, d1: { timelineItems: { nodes: [] } } }, rateLimit: RATE_LIMIT_REPLY },
          errors: [{ type: 'SOME_ERROR', path: ['repository', 'd0', 'timelineItems'], message: 'boom' }],
        }),
    })
    const result = await readWith(runner)
    expect(result.ok).toBe(false)
  })

  it('a detail alias that comes back null, with no error entry, fails the whole read too', async () => {
    const { runner } = scripted({
      sweep,
      details: () => ok({ data: { repository: { d0: { timelineItems: { nodes: [] } }, d1: null }, rateLimit: RATE_LIMIT_REPLY } }),
    })
    const result = await readWith(runner)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('#2')
  })
})

const TRACKED_PLAN: TrackedRef = { kind: 'issue', number: 3, keys: ['marker', 'planReview'] }

function trackedNode(number: number, labels: readonly string[], state = 'OPEN'): Record<string, unknown> {
  return { ...node(number, labels), state }
}

describe('readBoardIssues — tracked issues', () => {
  it('reads by labels, and reports nothing closed, when tracked is null', async () => {
    const { runner, documents } = scripted({ sweep: () => ok(sweepBody({ issues: connection([node(1, ['ready'])]) })) })
    const result = await readWith(runner, VOCABULARY, null)
    expect(result.ok && result.swept.map((item) => item.number)).toEqual([1])
    expect(result.ok && result.closed).toEqual([])
    expect(documents.some((document) => document.includes('t0:'))).toBe(false)
  })

  it('drops a swept issue the store does not track, and costs no extra read when every tracked issue was swept', async () => {
    const { runner, documents } = scripted({ sweep: () => ok(sweepBody({ issues: connection([node(1, ['ready']), node(3, ['plan review'])]) })) })
    const result = await readWith(runner, VOCABULARY, [TRACKED_PLAN])
    expect(result.ok && result.swept.map((item) => item.number)).toEqual([3])
    expect(documents.some((document) => document.includes('t0:'))).toBe(false)
  })

  it('keeps the store\'s keys on a swept issue whose labels disagree', async () => {
    const { runner } = scripted({ sweep: () => ok(sweepBody({ issues: connection([node(3, ['ready'])]) })) })
    const result = await readWith(runner, VOCABULARY, [TRACKED_PLAN])
    expect(result.ok && result.swept[0]?.matchedKeys).toEqual(['marker', 'planReview'])
  })

  it('fetches a tracked issue whose labels were all removed, by number, keeps its stored keys, and returns it apart from the swept ones', async () => {
    const { runner, documents } = scripted({
      sweep: () => ok(sweepBody({ issues: connection([]) })),
      tracked: () => ok({ data: { repository: { t0: node(3, []) }, rateLimit: RATE_LIMIT_REPLY } }),
    })
    const result = await readWith(runner, VOCABULARY, [TRACKED_PLAN])
    expect(result.ok && result.swept).toEqual([])
    expect(result.ok && result.tracked).toHaveLength(1)
    expect(result.ok && result.tracked[0]).toMatchObject({ number: 3, kind: 'issue', matchedKeys: ['marker', 'planReview'] })
    expect(documents.find((document) => document.includes('t0:'))).toContain('t0: issue(number: 3)')
  })

  it('reports a non-open tracked issue as closed rather than as an item', async () => {
    const { runner } = scripted({
      sweep: () => ok(sweepBody({ issues: connection([]) })),
      tracked: () => ok({ data: { repository: { t0: trackedNode(3, ['plan review'], 'CLOSED') }, rateLimit: RATE_LIMIT_REPLY } }),
    })
    const result = await readWith(runner, VOCABULARY, [TRACKED_PLAN])
    expect(result.ok && result.tracked).toEqual([])
    expect(result.ok && result.closed).toEqual([3])
  })

  it('reports an issue GitHub no longer has as closed', async () => {
    const { runner } = scripted({
      sweep: () => ok(sweepBody({ issues: connection([]) })),
      tracked: () => ok({ data: { repository: { t0: null }, rateLimit: RATE_LIMIT_REPLY }, errors: [{ type: 'NOT_FOUND', path: ['repository', 't0'], message: 'gone' }] }),
    })
    const result = await readWith(runner, VOCABULARY, [TRACKED_PLAN])
    expect(result.ok && result.closed).toEqual([3])
  })

  it('fails the whole read when a tracked alias errors for any other reason, never reading it as closed', async () => {
    const { runner } = scripted({
      sweep: () => ok(sweepBody({ issues: connection([]) })),
      tracked: () => ok({ data: { repository: { t0: null }, rateLimit: RATE_LIMIT_REPLY }, errors: [{ type: 'FORBIDDEN', path: ['repository', 't0'], message: 'no' }] }),
    })
    const result = await readWith(runner, VOCABULARY, [TRACKED_PLAN])
    expect(result.ok).toBe(false)
  })
})
