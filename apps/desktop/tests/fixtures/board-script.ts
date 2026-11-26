// A scripted GitHub transport for the board read. It answers by the document's own content, never by
// call order, because the issue and pull-request halves run in parallel.
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { GitHubHttpResult, GitHubTransport } from '@/types/platform'
import { RATE_LIMIT_REPLY, connection } from './pipeline-reply'
import { httpOk, queryOf } from './github-http'

export const REPO = { owner: 'o', name: 'r' }
export const VOCABULARY = resolveVocabulary({})
export const REPO_LABELS_OK = { totalCount: VOCABULARY.labels.length, nodes: VOCABULARY.labels.map((label) => ({ name: label.name })) }

export function ok(body: unknown): GitHubHttpResult {
  return httpOk(JSON.stringify(body))
}

export function node(number: number, labels: readonly string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { number, title: `item ${number}`, url: `https://github.com/o/r/issues/${number}`, body: '', state: 'OPEN', assignees: { nodes: [] }, labels: { nodes: labels.map((name) => ({ name })) }, ...extra }
}

interface IssueSweep {
  readonly issues?: unknown
  readonly rateLimit?: unknown
  readonly viewer?: unknown
  readonly repoLabels?: unknown
  readonly errors?: readonly unknown[]
}

export function issueSweepBody(body: IssueSweep): Record<string, unknown> {
  const repository: Record<string, unknown> = { repoLabels: body.repoLabels ?? REPO_LABELS_OK }
  if (body.issues !== undefined) repository.issues = body.issues
  return { data: { repository, rateLimit: body.rateLimit ?? RATE_LIMIT_REPLY, ...(body.viewer !== undefined ? { viewer: body.viewer } : {}) }, ...(body.errors !== undefined ? { errors: body.errors } : {}) }
}

interface PullSweep {
  readonly pullRequests?: unknown
  readonly rateLimit?: unknown
  readonly integrationHistory?: unknown
  readonly errors?: readonly unknown[]
}

export function pullSweepBody(body: PullSweep): Record<string, unknown> {
  const repository: Record<string, unknown> = { integrationHistory: body.integrationHistory ?? null }
  if (body.pullRequests !== undefined) repository.pullRequests = body.pullRequests
  return { data: { repository, rateLimit: body.rateLimit ?? RATE_LIMIT_REPLY }, ...(body.errors !== undefined ? { errors: body.errors } : {}) }
}

/** The integration branch's history alias, `commits` being each commit's rollup contexts. */
export function integrationHistoryOf(commits: readonly (readonly unknown[])[]): unknown {
  return { target: { history: { nodes: commits.map((contexts) => ({ oid: 'abc', statusCheckRollup: { contexts: { nodes: contexts } } })) } } }
}

const ALIAS_PATTERN = /d(\d+): (issue|pullRequest)\(number: (\d+)\)/g

/** One empty detail node per alias the document asks for. */
export function emptyDetails(document: string, rateLimit: unknown = RATE_LIMIT_REPLY): GitHubHttpResult {
  const repository: Record<string, unknown> = {}
  for (const match of document.matchAll(ALIAS_PATTERN)) {
    repository[`d${match[1]}`] = match[2] === 'issue' ? { timelineItems: { nodes: [] }, blockedBy: { totalCount: 0, nodes: [] } } : { timelineItems: { nodes: [] }, reviews: { nodes: [] }, comments: { nodes: [] } }
  }
  return ok({ data: { repository, rateLimit } })
}

const NO_TRACKED = (): GitHubHttpResult => ok({ data: { repository: {}, rateLimit: RATE_LIMIT_REPLY } })

interface Script {
  /** Each issue-sweep page, by the number of issue-sweep pages asked so far. */
  readonly issues?: (document: string, page: number) => GitHubHttpResult
  readonly pulls?: (document: string, page: number) => GitHubHttpResult
  readonly trackedIssues?: (document: string) => GitHubHttpResult
  readonly trackedPulls?: (document: string) => GitHubHttpResult
  readonly issueDetails?: (document: string) => GitHubHttpResult
  readonly pullDetails?: (document: string) => GitHubHttpResult
}

export interface ScriptedBoard {
  readonly transport: GitHubTransport
  readonly documents: string[]
}

/** Every unscripted document answers as an empty board. */
export function scriptedBoard(script: Script): ScriptedBoard {
  const documents: string[] = []
  let issuePages = 0
  let pullPages = 0
  const answer = (document: string): GitHubHttpResult => {
    if (document.includes('t0:')) return (document.includes('t0: issue(') ? (script.trackedIssues ?? NO_TRACKED) : (script.trackedPulls ?? NO_TRACKED))(document)
    if (document.includes('d0:')) return (document.includes('d0: issue(') ? (script.issueDetails ?? emptyDetails) : (script.pullDetails ?? emptyDetails))(document)
    // Page one of the issue sweep carries `repoLabels` even with no connection; a later page only the connection.
    if (document.includes('repoLabels') || document.includes('issues(')) return (script.issues ?? (() => ok(issueSweepBody({ issues: connection([]) }))))(document, issuePages++)
    return (script.pulls ?? (() => ok(pullSweepBody({ pullRequests: connection([]) }))))(document, pullPages++)
  }
  const transport: GitHubTransport = (request) => {
    const document = queryOf(request)
    documents.push(document)
    return Promise.resolve(answer(document))
  }
  return { transport, documents }
}
