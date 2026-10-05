// fetchBacklog: every open issue, dropping anything carrying a vocabulary label.
import { gh as defaultGh } from '../platform/gh'
import type { GhOptions, GhResult, GhRunner } from '../platform/gh'
import type { LabelVocabulary } from '../../shared/labels/vocabulary'
import type { BacklogItem, BacklogResponse } from '../../shared/backlog/types'
import { classifyFailure, parseEnvelope } from './envelope'
import { fieldListOf } from './map'
import type { RepoRef } from './adapter'

export type { GhRunner }

const PAGE_SIZE = 100
const ASSIGNEE_PAGE_SIZE = 10
const ITEM_LABEL_PAGE_SIZE = 20

function stdoutOf(result: GhResult): string | undefined {
  return 'stdout' in result ? result.stdout : undefined
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
    `        labels(first: ${ITEM_LABEL_PAGE_SIZE}) { nodes { name } }`,
    `        assignees(first: ${ASSIGNEE_PAGE_SIZE}) { nodes { login } }`,
    '      }',
    '    }',
    '  }',
    '  viewer { login }',
    '}',
  ].join('\n')
}

export interface FetchBacklogParams {
  readonly repo: RepoRef
  readonly vocabulary: LabelVocabulary
  readonly gh?: GhRunner
  readonly now?: () => Date
}

// `scanned`/`total` diverging means the page was truncated; a viewer-query error is never itself a failure.
export async function fetchBacklog(params: FetchBacklogParams): Promise<BacklogResponse> {
  const runner = params.gh ?? defaultGh
  const now = params.now ?? (() => new Date())
  const fetchedAt = now().toISOString()

  const document = buildBacklogQuery()
  const ghResult = await runner(['api', 'graphql', '-f', `query=${document}`, '-f', `owner=${params.repo.owner}`, '-f', `name=${params.repo.name}`])

  const stdout = stdoutOf(ghResult)
  const parsed = stdout !== undefined ? parseEnvelope(stdout) : undefined
  const verdict = classifyFailure(ghResult, parsed)

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

  const items: BacklogItem[] = []
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) continue
    const issue = node as Record<string, unknown>
    const labels = fieldListOf(issue.labels, 'name')
    if (labels.some((name) => vocabularyNames.has(name))) continue
    items.push({
      number: typeof issue.number === 'number' ? issue.number : 0,
      title: typeof issue.title === 'string' ? issue.title : '',
      url: typeof issue.url === 'string' ? issue.url : '',
      updatedAt: typeof issue.updatedAt === 'string' ? issue.updatedAt : '',
      assignees: fieldListOf(issue.assignees, 'login'),
    })
  }

  return { ok: true, items, scanned: nodes.length, total, viewer, fetchedAt }
}
