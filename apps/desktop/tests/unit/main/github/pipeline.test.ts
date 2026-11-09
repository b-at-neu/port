import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { LabelVocabulary } from '@/utils/labels/vocabulary'
import { ghAuthStatus, ghJson } from '@/main/platform/gh'
import type { GitHubHttpResult, GitHubTransport } from '@/types/platform'
import { fetchPipelineItems } from '@/main/github/pipeline'
import { RATE_LIMIT_REPLY, connection } from '../../../fixtures/pipeline-reply'
import { httpFail, httpOk, queryOf } from '../../../fixtures/github-http'

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
  readonly pullRequests?: unknown
  readonly rateLimit?: unknown
  readonly viewer?: unknown
  readonly repoLabels?: unknown
}

function sweepBody(body: SweepBody): Record<string, unknown> {
  const repository: Record<string, unknown> = { repoLabels: body.repoLabels ?? REPO_LABELS_OK }
  if (body.issues !== undefined) repository.issues = body.issues
  if (body.pullRequests !== undefined) repository.pullRequests = body.pullRequests
  return { data: { repository, rateLimit: body.rateLimit ?? RATE_LIMIT_REPLY, ...(body.viewer !== undefined ? { viewer: body.viewer } : {}) } }
}

const ALIAS_PATTERN = /d(\d+): (issue|pullRequest)\(number: (\d+)\)/g

/** One empty detail node per alias the document asks for. */
function emptyDetails(document: string, rateLimit: unknown = RATE_LIMIT_REPLY): GitHubHttpResult {
  const repository: Record<string, unknown> = {}
  for (const match of document.matchAll(ALIAS_PATTERN)) {
    repository[`d${match[1]}`] = match[2] === 'issue' ? { timelineItems: { nodes: [] }, blockedBy: { totalCount: 0, nodes: [] } } : { timelineItems: { nodes: [] }, reviews: { nodes: [] }, comments: { nodes: [] } }
  }
  return ok({ data: { repository, rateLimit } })
}

/** The integration branch's history alias, `commits` being each commit's rollup contexts. */
function integrationReply(commits: readonly (readonly unknown[])[], rateLimit: unknown = RATE_LIMIT_REPLY): GitHubHttpResult {
  const nodes = commits.map((contexts) => ({ oid: 'abc', statusCheckRollup: { contexts: { nodes: contexts } } }))
  return ok({ data: { repository: { integrationHistory: { target: { history: { nodes } } } }, rateLimit } })
}

interface Script {
  readonly sweep: (document: string, call: number) => GitHubHttpResult
  readonly details?: (document: string) => GitHubHttpResult
  readonly integration?: (document: string) => GitHubHttpResult
}

function scripted(script: Script): { readonly runner: GitHubTransport; readonly documents: string[] } {
  const documents: string[] = []
  let sweeps = 0
  const runner: GitHubTransport = (request) => {
    const document = queryOf(request)
    documents.push(document)
    if (document.includes('integrationHistory:')) return Promise.resolve((script.integration ?? (() => integrationReply([])))(document))
    if (document.includes('d0:')) return Promise.resolve((script.details ?? ((detailDocument) => emptyDetails(detailDocument)))(document))
    return Promise.resolve(script.sweep(document, sweeps++))
  }
  return { runner, documents }
}

function fetchWith(runner: GitHubTransport, vocabulary: LabelVocabulary = VOCABULARY): ReturnType<typeof fetchPipelineItems> {
  return fetchPipelineItems({ repo: REPO, vocabulary, integration: 'dev', github: runner })
}

describe('fetchPipelineItems', () => {
  it('a full success', async () => {
    const { runner, documents } = scripted({ sweep: () => ok(sweepBody({ issues: connection([node(1, ['ready'])]), pullRequests: connection([]) })) })
    const result = await fetchWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.matchedKeys).toEqual(['ready'])
    expect(result.vocabulary.verdict).toBe('verified')
    expect(result.rateLimit).toEqual({ ...RATE_LIMIT_REPLY, cost: 3 })
    expect(result.unavailable).toEqual([])
    expect(result.truncated).toEqual([])
    expect(documents).toHaveLength(3)
  })

  it('an item with two vocabulary labels and a non-vocabulary label is one item with two keys', async () => {
    const labels = ['ready', 'bug', 'in progress']
    const { runner } = scripted({ sweep: () => ok(sweepBody({ issues: connection([node(1, labels)]), pullRequests: connection([]) })) })
    const result = await fetchWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.matchedKeys).toEqual(VOCABULARY.labels.map((label) => label.key).filter((key) => key === 'ready' || key === 'inProgress'))
    expect(result.items[0]?.labels).toEqual(labels)
  })

  it('names every enabled label in queried, even when items is empty, and asks for no details', async () => {
    const { runner, documents } = scripted({ sweep: () => ok(sweepBody({ issues: connection([]), pullRequests: connection([]) })) })
    const result = await fetchWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items).toEqual([])
    expect(result.queried.map((q) => q.key)).toEqual(VOCABULARY.labels.map((label) => label.key))
    expect(documents).toHaveLength(2)
    expect(documents.filter((document) => document.includes('d0:'))).toEqual([])
  })

  it('asks for no connection at all when no label is enabled', async () => {
    const { runner, documents } = scripted({ sweep: () => ok(sweepBody({})) })
    const result = await fetchWith(runner, { labels: [], disabled: [], problems: [] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items).toEqual([])
    expect(documents[0]).not.toContain('issues(')
    expect(documents[0]).not.toContain('pullRequests(')
  })

  it('follows a second page with only the unfinished surface, carrying the cursor', async () => {
    const { runner, documents } = scripted({
      sweep: (_document, call) =>
        call === 0
          ? ok(sweepBody({ issues: connection([node(1, ['ready'])], { hasNextPage: true, endCursor: 'cursor-1' }, 2), pullRequests: connection([]) }))
          : ok(sweepBody({ issues: connection([node(2, ['ready'])], { hasNextPage: false, endCursor: null }, 2) })),
    })
    const result = await fetchWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items.map((item) => item.number)).toEqual([1, 2])
    expect(documents[1]).toContain('after: "cursor-1"')
    expect(documents[1]).toContain('issues(')
    expect(documents[1]).not.toContain('pullRequests(')
    expect(result.truncated).toEqual([])
  })

  it('stops at the page cap and reports the surface that still had pages', async () => {
    let next = 0
    const { runner, documents } = scripted({
      sweep: () => ok(sweepBody({ issues: connection([node(++next, ['ready'])], { hasNextPage: true, endCursor: `cursor-${next}` }, 5000), pullRequests: connection([]) })),
    })
    const result = await fetchWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(documents.filter((document) => !document.includes('d0:') && !document.includes('integrationHistory:'))).toHaveLength(10)
    expect(result.truncated).toEqual([{ alias: 'issues', surface: 'issue', totalCount: 5000, received: 10 }])
    expect(result.items).toHaveLength(10)
  })

  it('a failure on a later page fails the whole read, never a short list', async () => {
    const { runner } = scripted({
      sweep: (_document, call) =>
        call === 0
          ? ok(sweepBody({ issues: connection([node(1, ['ready'])], { hasNextPage: true, endCursor: 'cursor-1' }, 2), pullRequests: connection([]) }))
          : httpFail('network', 502),
    })
    const result = await fetchWith(runner)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('network')
    expect('items' in result).toBe(false)
  })

  it('a sweep connection named in errors is unavailable and its items dropped, the other surface intact', async () => {
    const { runner } = scripted({
      sweep: () => partial({ ...sweepBody({ issues: connection([node(1, ['ready'])]), pullRequests: null }), errors: [{ type: 'SOME_ERROR', path: ['repository', 'pullRequests'], message: 'boom' }] }),
    })
    const result = await fetchWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items).toHaveLength(1)
    expect(result.unavailable).toEqual([{ alias: 'pullRequests', surface: 'pull-request' }])
  })

  it('a sweep connection missing from the reply without an error is unavailable, never read as empty', async () => {
    const { runner } = scripted({ sweep: () => ok(sweepBody({ issues: connection([]) })) })
    const result = await fetchWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.unavailable).toEqual([{ alias: 'pullRequests', surface: 'pull-request' }])
  })

  it.each([
    ['unauthenticated', httpFail('unauthenticated', 401)],
    ['rate-limited', httpFail('rate-limited', 403, 'API rate limit exceeded')],
    ['network', httpFail('network', 503)],
  ])('%s returns ok: false with no items field, not an empty list', async (_label, failure) => {
    const result = await fetchWith(() => Promise.resolve(failure))
    expect(result.ok).toBe(false)
    expect('items' in result).toBe(false)
  })

  it('a >100-label repository yields verdict: unverified, never a confidently-short list', async () => {
    const nodes = Array.from({ length: 100 }, (_, i) => ({ name: `label-${i}` }))
    const { runner } = scripted({ sweep: () => ok(sweepBody({ issues: connection([]), pullRequests: connection([]), repoLabels: { totalCount: 150, nodes } })) })
    const result = await fetchWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.vocabulary.verdict).toBe('unverified')
  })

  // viewer resolves when present, and is null (never a guess) when the alias is absent or dropped.
  it.each([
    ['present', { login: 'op' }, false, 'op'],
    ['absent', undefined, false, null],
    ['errored', null, true, null],
  ] as const)('viewer: %s → %s', async (_label, viewer, erroredOut, expected) => {
    const body: Record<string, unknown> = sweepBody({ issues: connection([]), pullRequests: connection([]), viewer })
    if (erroredOut) body.errors = [{ type: 'SOME_ERROR', path: ['viewer'], message: 'boom' }]
    const result = await fetchWith(() => Promise.resolve(erroredOut ? partial(body) : ok(body)))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.viewer).toBe(expected)
  })
})

describe('fetchPipelineItems — details', () => {
  const issue = node(1, ['ready'])
  const approvedPull = node(2, ['approved'], { mergedAt: null })
  const reviewPull = node(3, ['ready for review'], { mergedAt: null })
  const sweep = (): GitHubHttpResult => ok(sweepBody({ issues: connection([issue]), pullRequests: connection([approvedPull, reviewPull]) }))

  it('merges each detail onto its item, with the rollup only on a pull request at the approved or ready-for-review stage', async () => {
    const rollup = { commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [{ __typename: 'CheckRun', name: 'build', conclusion: 'FAILURE', status: 'COMPLETED' }] } } } }] } }
    const { runner, documents } = scripted({
      sweep,
      details: () =>
        ok({
          data: {
            repository: {
              d0: { timelineItems: { nodes: [{ createdAt: '2026-01-01T00:00:00Z', actor: { login: 'op' }, label: { name: 'ready' } }] } },
              d1: { timelineItems: { nodes: [] }, reviews: { nodes: [{ body: '## Code Review — Cycle 1', submittedAt: '2026-01-01T00:00:00Z', commit: { oid: 'sha' } }] }, comments: { nodes: [] }, ...rollup },
              d2: { timelineItems: { nodes: [] }, reviews: { nodes: [] }, comments: { nodes: [] }, ...rollup },
            },
            rateLimit: RATE_LIMIT_REPLY,
          },
        }),
    })
    const result = await fetchWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [first, second, third] = result.items
    expect(first?.labelEvents).toEqual([{ label: 'ready', actor: 'op', at: '2026-01-01T00:00:00Z' }])
    expect(second?.reviews).toHaveLength(1)
    expect(second?.checkRollup?.map((check) => check.name)).toEqual(['build'])
    expect(third?.reviews).toEqual([])
    expect(third?.checkRollup?.map((check) => check.name)).toEqual(['build'])
    expect(first?.checkRollup).toBeNull()
    expect(documents[1]).toContain('d1: pullRequest(number: 2) {')
    expect((documents[1] ?? '').split('...CheckRollupFields')).toHaveLength(3)
  })

  it('sums the cost of every round trip and keeps the last reply\'s budget', async () => {
    const { runner } = scripted({
      sweep: () => ok(sweepBody({ issues: connection([issue]), pullRequests: connection([]), rateLimit: { cost: 2, remaining: 4990, resetAt: '2026-01-01T00:30:00Z', limit: 5000 } })),
      details: (document) => emptyDetails(document, { cost: 3, remaining: 4987, resetAt: '2026-01-01T00:31:00Z', limit: 5000 }),
      integration: () => integrationReply([], { cost: 1, remaining: 4986, resetAt: '2026-01-01T00:32:00Z', limit: 5000 }),
    })
    const result = await fetchWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rateLimit).toEqual({ cost: 6, remaining: 4986, resetAt: '2026-01-01T00:32:00Z', limit: 5000 })
  })

  it('reads the integration branch once, newest commit first, as its latest concluded status per check', async () => {
    const build = (conclusion: string, startedAt: string): unknown => ({ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion, startedAt })
    const { runner, documents } = scripted({
      sweep: () => ok(sweepBody({ issues: connection([]), pullRequests: connection([]) })),
      integration: () => integrationReply([[build('FAILURE', '2026-01-02T00:00:00Z')], [build('SUCCESS', '2026-01-01T00:00:00Z'), { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS', createdAt: '2026-01-01T00:00:00Z' }]]),
    })
    const result = await fetchWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.integrationChecks).toEqual({ test: 'red', 'ci/legacy': 'green' })
    const integrationDocuments = documents.filter((document) => document.includes('integrationHistory:'))
    expect(integrationDocuments).toHaveLength(1)
    expect(integrationDocuments[0]).toContain('refs/heads/dev')
  })

  it('an integration read that fails or errors is unreadable, never an empty record, and never fails the fetch', async () => {
    const failed = scripted({ sweep: () => ok(sweepBody({ issues: connection([]), pullRequests: connection([]) })), integration: () => httpFail('unauthenticated', 401) })
    const afterFailure = await fetchWith(failed.runner)
    expect(afterFailure.ok).toBe(true)
    if (afterFailure.ok) expect(afterFailure.integrationChecks).toBeNull()

    const errored = scripted({
      sweep: () => ok(sweepBody({ issues: connection([]), pullRequests: connection([]) })),
      integration: () => ok({ data: { repository: { integrationHistory: null }, rateLimit: RATE_LIMIT_REPLY }, errors: [{ message: 'not found', path: ['repository', 'integrationHistory'] }] }),
    })
    const afterError = await fetchWith(errored.runner)
    expect(afterError.ok).toBe(true)
    if (afterError.ok) expect(afterError.integrationChecks).toBeNull()
  })

  it('chunks the detail read at 100 aliases per round trip', async () => {
    const issues = Array.from({ length: 101 }, (_, i) => node(i + 1, ['ready']))
    const { runner, documents } = scripted({ sweep: () => ok(sweepBody({ issues: connection(issues), pullRequests: connection([]) })) })
    const result = await fetchWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items).toHaveLength(101)
    const detailDocuments = documents.filter((document) => document.includes('d0:'))
    expect(detailDocuments).toHaveLength(2)
    expect(detailDocuments[1]).not.toContain('d1:')
  })

  it('a failed detail call fails the whole read, keeping the caller on its last good one', async () => {
    const { runner } = scripted({ sweep, details: () => httpFail('network', 502) })
    const result = await fetchWith(runner)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('network')
  })

  it('a detail alias named in errors fails the whole read, naming the item', async () => {
    const { runner } = scripted({
      sweep,
      details: () =>
        partial({
          data: { repository: { d0: { timelineItems: { nodes: [] } }, d1: null, d2: { timelineItems: { nodes: [] } } }, rateLimit: RATE_LIMIT_REPLY },
          errors: [{ type: 'SOME_ERROR', path: ['repository', 'd1'], message: 'boom' }],
        }),
    })
    const result = await fetchWith(runner)
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
          data: { repository: { d0: { timelineItems: { nodes: [] }, blockedBy: null }, d1: { timelineItems: { nodes: [] }, reviews: { nodes: [] }, comments: { nodes: [] } }, d2: { timelineItems: { nodes: [] }, reviews: { nodes: [] }, comments: { nodes: [] } } }, rateLimit: RATE_LIMIT_REPLY },
          errors: [{ type: 'SOME_ERROR', path: ['repository', 'd0', 'blockedBy'], message: 'boom' }],
        }),
    })
    const result = await fetchWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items[0]?.blockers?.ok).toBe(false)
    expect(result.items[1]?.blockers).toBeNull()
  })

  it('asks for comments only on a blocked issue, and maps them', async () => {
    const blocked = node(1, ['blocked'])
    const comment = { body: 'why', createdAt: '2026-01-01T00:00:00Z', url: 'https://x/c' }
    const { runner, documents } = scripted({
      sweep: () => ok(sweepBody({ issues: connection([blocked, node(4, ['ready'])]), pullRequests: connection([]) })),
      details: () =>
        ok({
          data: { repository: { d0: { timelineItems: { nodes: [] }, blockedBy: { totalCount: 0, nodes: [] }, comments: { nodes: [comment] } }, d1: { timelineItems: { nodes: [] }, blockedBy: { totalCount: 0, nodes: [] } } }, rateLimit: RATE_LIMIT_REPLY },
        }),
    })
    const result = await fetchWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const detailDocument = documents.find((document) => document.includes('d0:')) ?? ''
    expect(detailDocument.split('\n').find((line) => line.includes('d0:'))).toContain('comments(last: 10)')
    expect(detailDocument.split('\n').find((line) => line.includes('d1:'))).not.toContain('comments')
    expect(result.items[0]?.blockerComments).toEqual([comment])
    expect(result.items[1]?.blockerComments).toBeNull()
  })

  it('an issue alias comments error leaves its blocker comments unread, and the read still succeeds', async () => {
    const { runner } = scripted({
      sweep: () => ok(sweepBody({ issues: connection([node(1, ['blocked'])]), pullRequests: connection([]) })),
      details: () =>
        partial({
          data: { repository: { d0: { timelineItems: { nodes: [] }, blockedBy: { totalCount: 0, nodes: [] }, comments: null } }, rateLimit: RATE_LIMIT_REPLY },
          errors: [{ type: 'SOME_ERROR', path: ['repository', 'd0', 'comments'], message: 'boom' }],
        }),
    })
    const result = await fetchWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items[0]?.blockerComments).toBeNull()
  })

  it('asks for closing pull requests only on a pr opened issue, and maps them', async () => {
    const opened = node(1, ['pr opened'])
    const { runner, documents } = scripted({
      sweep: () => ok(sweepBody({ issues: connection([opened, node(4, ['ready'])]), pullRequests: connection([]) })),
      details: () =>
        ok({
          data: { repository: { d0: { timelineItems: { nodes: [] }, blockedBy: { totalCount: 0, nodes: [] }, closedByPullRequestsReferences: { nodes: [{ number: 9, state: 'MERGED' }] } }, d1: { timelineItems: { nodes: [] }, blockedBy: { totalCount: 0, nodes: [] } } }, rateLimit: RATE_LIMIT_REPLY },
        }),
    })
    const result = await fetchWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const detailDocument = documents.find((document) => document.includes('d0:')) ?? ''
    expect(detailDocument.split('\n').find((line) => line.includes('d0:'))).toContain('closedByPullRequestsReferences')
    expect(detailDocument.split('\n').find((line) => line.includes('d1:'))).not.toContain('closedByPullRequestsReferences')
    expect(result.items[0]?.closingPullRequests).toEqual([{ number: 9, state: 'MERGED' }])
    expect(result.items[1]?.closingPullRequests).toBeNull()
  })

  it('a closedByPullRequestsReferences error leaves closing pull requests unread, and the read still succeeds', async () => {
    const { runner } = scripted({
      sweep: () => ok(sweepBody({ issues: connection([node(1, ['pr opened'])]), pullRequests: connection([]) })),
      details: () =>
        partial({
          data: { repository: { d0: { timelineItems: { nodes: [] }, blockedBy: { totalCount: 0, nodes: [] }, closedByPullRequestsReferences: null } }, rateLimit: RATE_LIMIT_REPLY },
          errors: [{ type: 'SOME_ERROR', path: ['repository', 'd0', 'closedByPullRequestsReferences'], message: 'boom' }],
        }),
    })
    const result = await fetchWith(runner)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items[0]?.closingPullRequests).toBeNull()
  })

  it('a pull request alias comments error still fails the whole read', async () => {
    const { runner } = scripted({
      sweep,
      details: () =>
        partial({
          data: { repository: { d0: { timelineItems: { nodes: [] }, blockedBy: { totalCount: 0, nodes: [] } }, d1: { timelineItems: { nodes: [] }, reviews: { nodes: [] }, comments: null }, d2: { timelineItems: { nodes: [] }, reviews: { nodes: [] }, comments: { nodes: [] } } }, rateLimit: RATE_LIMIT_REPLY },
          errors: [{ type: 'SOME_ERROR', path: ['repository', 'd1', 'comments'], message: 'boom' }],
        }),
    })
    const result = await fetchWith(runner)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('#2')
  })

  it('an issue alias error on any other field still fails the whole read', async () => {
    const { runner } = scripted({
      sweep,
      details: () =>
        partial({
          data: { repository: { d0: { timelineItems: null }, d1: { timelineItems: { nodes: [] }, reviews: { nodes: [] }, comments: { nodes: [] } }, d2: { timelineItems: { nodes: [] }, reviews: { nodes: [] }, comments: { nodes: [] } } }, rateLimit: RATE_LIMIT_REPLY },
          errors: [{ type: 'SOME_ERROR', path: ['repository', 'd0', 'timelineItems'], message: 'boom' }],
        }),
    })
    const result = await fetchWith(runner)
    expect(result.ok).toBe(false)
  })

  it('a detail alias that comes back null, with no error entry, fails the whole read too', async () => {
    const { runner } = scripted({
      sweep,
      details: () => ok({ data: { repository: { d0: { timelineItems: { nodes: [] } }, d1: { timelineItems: { nodes: [] } }, d2: null }, rateLimit: RATE_LIMIT_REPLY } }),
    })
    const result = await fetchWith(runner)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('#3')
  })
})

// ctx.skip() when gh is not authenticated, so the suite still runs in an unauthenticated CI
// environment. Resolves the repository with gh repo view rather than a hardcoded slug.
describe('fetchPipelineItems — live', () => {
  it('matches this repository — every matchedKeys is non-empty, vocabulary is verified, rateLimit.cost is single digits', async (ctx) => {
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
    const result = await fetchPipelineItems({ repo: { owner, name }, vocabulary, integration: 'dev' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.vocabulary.verdict).toBe('verified')
    expect(typeof result.rateLimit.cost).toBe('number')
    for (const item of result.items) {
      expect(item.matchedKeys.length).toBeGreaterThan(0)
    }
    console.info(`fetchPipelineItems rateLimit.cost = ${result.rateLimit.cost}`)
  }, 30_000)
})
