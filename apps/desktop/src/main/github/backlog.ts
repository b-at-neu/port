// fetchBacklog: every open issue, dropping anything carrying a vocabulary label.
import { githubHttp } from '@/main/platform/github-http'
import type { GitHubTransport } from '@/types/platform'
import type { LabelVocabulary } from '@/utils/labels/vocabulary'
import type { BacklogItem, BacklogLabel, BacklogResponse, ParentRead } from '@/types/backlog'
import { bodyOf, classifyFailure, parseEnvelope } from '@/main/github/envelope'
import { fieldListOf } from '@/main/github/map'
import { toBlockerRead } from '@/main/github/blockers'
import { EMPTY_CHILDREN, fetchChildren } from '@/main/github/backlog-children'
import { blockedByField, blockingField } from '@/main/github/query'
import { repoGraphqlRequest } from '@/main/github/request'
import type { GitHubRepoRef, GraphQLErrorEntry } from '@/types/github'
import { isHexColor } from '@/utils/hex-color'


const PAGE_SIZE = 100
const ASSIGNEE_PAGE_SIZE = 10
const ITEM_LABEL_PAGE_SIZE = 20
const BLOCKER_PAGE_SIZE = 10
const BLOCKING_PAGE_SIZE = 10

export function labelsOf(value: unknown): readonly BacklogLabel[] {
  const nodes = (value as { nodes?: unknown } | null | undefined)?.nodes
  if (!Array.isArray(nodes)) return []
  const out: BacklogLabel[] = []
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) continue
    const { name, color } = node as Record<string, unknown>
    if (typeof name !== 'string') continue
    out.push({ name, color: typeof color === 'string' && isHexColor(color) ? color.toLowerCase() : null })
  }
  return out
}

function subIssueCountOf(value: unknown): number {
  const total = (value as { totalCount?: unknown } | null | undefined)?.totalCount
  return typeof total === 'number' && Number.isInteger(total) && total > 0 ? total : 0
}

function nodeFieldErrored(errors: readonly GraphQLErrorEntry[], index: number, field: string): boolean {
  return errors.some((error) => {
    const path = error.path
    return path?.[0] === 'repository' && path[1] === 'issues' && path[2] === 'nodes' && path[3] === index && path[4] === field
  })
}

function parentOf(issue: Record<string, unknown>, errored: boolean): ParentRead {
  if (errored) return { ok: false, reason: "GitHub reported an error reading this issue's parent" }
  if (!('parent' in issue)) return { ok: false, reason: 'parent is missing from the response' }
  const parent = issue.parent
  if (parent === null) return { ok: true, parent: null }
  const raw = typeof parent === 'object' ? (parent as Record<string, unknown>) : {}
  if (typeof raw.number !== 'number' || (raw.state !== 'OPEN' && raw.state !== 'CLOSED')) return { ok: false, reason: 'parent is malformed' }
  return { ok: true, parent: { number: raw.number, title: typeof raw.title === 'string' ? raw.title : '', state: raw.state } }
}

function buildBacklogQuery(): string {
  return [
    'query($owner: String!, $name: String!) {',
    '  repository(owner: $owner, name: $name) {',
    `    issues(states: OPEN, first: ${PAGE_SIZE}, orderBy: {field: UPDATED_AT, direction: DESC}) {`,
    '      totalCount',
    '      nodes {',
    '        number',
    '        title',
    '        url',
    '        updatedAt',
    `        labels(first: ${ITEM_LABEL_PAGE_SIZE}) { nodes { name color } }`,
    '        subIssues { totalCount }',
    `        assignees(first: ${ASSIGNEE_PAGE_SIZE}) { nodes { login } }`,
    `        ${blockedByField(BLOCKER_PAGE_SIZE)}`,
    `        ${blockingField(BLOCKING_PAGE_SIZE)}`,
    '        parent { number title state }',
    '      }',
    '    }',
    '  }',
    '  viewer { login }',
    '}',
  ].join('\n')
}

interface FetchBacklogParams {
  readonly repo: GitHubRepoRef
  readonly vocabulary: LabelVocabulary
  readonly github?: GitHubTransport
  readonly now?: () => Date
}

// `scanned`/`total` diverging means the page was truncated; a viewer-query error is never itself a failure.
export async function fetchBacklog(params: FetchBacklogParams): Promise<BacklogResponse> {
  const github = params.github ?? githubHttp
  const now = params.now ?? (() => new Date())
  const fetchedAt = now().toISOString()

  const document = buildBacklogQuery()
  const result = await github(repoGraphqlRequest(document, params.repo))

  const text = bodyOf(result)
  const parsed = text !== undefined ? parseEnvelope(text) : undefined
  const verdict = classifyFailure(result, parsed)

  if (verdict.kind !== 'ok') {
    return { ok: false, kind: verdict.kind, message: verdict.message, fetchedAt }
  }
  if (parsed === undefined || !parsed.ok) {
    return { ok: false, kind: 'no-data', message: 'internal: an ok verdict without a parsed envelope', fetchedAt }
  }
  const body = parsed.value
  if (body.data === undefined || body.data === null || body.data.repository === undefined || body.data.repository === null) {
    return { ok: false, kind: 'no-data', message: 'internal: an ok verdict without usable repository data', fetchedAt }
  }
  const repository = body.data.repository as Readonly<Record<string, unknown>>
  const errors = body.errors ?? []

  const viewerErrored = errors.some((error) => error.path?.[0] === 'viewer')
  const viewerNode = body.data.viewer
  const viewerLogin = typeof viewerNode === 'object' && viewerNode !== null ? (viewerNode as Record<string, unknown>).login : undefined
  const viewer = !viewerErrored && typeof viewerLogin === 'string' && viewerLogin !== '' ? viewerLogin : null

  const connection = repository.issues
  if (typeof connection !== 'object' || connection === null) {
    return { ok: false, kind: 'no-data', message: "internal: an ok verdict without a usable 'issues' connection", fetchedAt }
  }
  const raw = connection as { totalCount?: unknown; nodes?: unknown }
  const total = typeof raw.totalCount === 'number' ? raw.totalCount : 0
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : []

  const vocabularyNames = new Set(params.vocabulary.labels.map((label) => label.name))

  const items: Omit<BacklogItem, 'children'>[] = []
  for (const [index, node] of nodes.entries()) {
    if (typeof node !== 'object' || node === null) continue
    const issue = node as Record<string, unknown>
    if (fieldListOf(issue.labels, 'name').some((name) => vocabularyNames.has(name))) continue
    items.push({
      number: typeof issue.number === 'number' ? issue.number : 0,
      title: typeof issue.title === 'string' ? issue.title : '',
      url: typeof issue.url === 'string' ? issue.url : '',
      updatedAt: typeof issue.updatedAt === 'string' ? issue.updatedAt : '',
      assignees: fieldListOf(issue.assignees, 'login'),
      labels: labelsOf(issue.labels),
      subIssueCount: subIssueCountOf(issue.subIssues),
      blockers: toBlockerRead(issue.blockedBy, nodeFieldErrored(errors, index, 'blockedBy')),
      blocking: toBlockerRead(issue.blocking, nodeFieldErrored(errors, index, 'blocking'), 'blocking'),
      parent: parentOf(issue, nodeFieldErrored(errors, index, 'parent')),
    })
  }

  const children = await fetchChildren({
    repo: params.repo,
    epics: items.filter((item) => item.subIssueCount > 0).map((item) => item.number),
    claimedNames: vocabularyNames,
    github,
  })

  const withChildren = items.map((item): BacklogItem => ({ ...item, children: children.get(item.number) ?? EMPTY_CHILDREN }))
  return { ok: true, items: withChildren, scanned: nodes.length, total, viewer, fetchedAt }
}
