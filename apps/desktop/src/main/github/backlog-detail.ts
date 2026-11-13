// fetchBacklogDetail: one open issue's body, people, and dependency links in one round trip.
import { githubHttp } from '@/main/platform/github-http'
import type { GitHubTransport } from '@/types/platform'
import type { BacklogDetailResponse, BacklogLinkList, BacklogParentRead } from '@/types/backlog'
import { bodyOf, classifyFailure, parseEnvelope } from '@/main/github/envelope'
import { fieldListOf } from '@/main/github/map'
import { blockedByField } from '@/main/github/query'
import { repoGraphqlRequest } from '@/main/github/request'
import type { ClaimBlocker, GitHubRepoRef } from '@/types/github'

const ASSIGNEE_PAGE_SIZE = 20
const LINK_PAGE_SIZE = 20
const LINK_FIELDS = new Set(['blockedBy', 'blocking', 'parent'])

function buildBacklogDetailQuery(number: number): string {
  const issueFields = [
    'number title url state body updatedAt',
    'author { login }',
    `assignees(first: ${ASSIGNEE_PAGE_SIZE}) { nodes { login } }`,
    'parent { number title url state }',
    blockedByField(LINK_PAGE_SIZE),
    `blocking(first: ${LINK_PAGE_SIZE}) { totalCount nodes { number title url state } }`,
  ].join(' ')
  return [
    'query($owner: String!, $name: String!) {',
    '  repository(owner: $owner, name: $name) {',
    `    detail: issueOrPullRequest(number: ${number}) { __typename ... on Issue { ${issueFields} } ... on PullRequest { number } }`,
    '  }',
    '}',
  ].join('\n')
}

function linkOf(value: unknown): ClaimBlocker | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const node = value as Record<string, unknown>
  return {
    number: typeof node.number === 'number' ? node.number : 0,
    title: typeof node.title === 'string' ? node.title : '',
    url: typeof node.url === 'string' ? node.url : '',
    state: typeof node.state === 'string' ? node.state : '',
  }
}

function toLinkList(value: unknown, errored: boolean, noun: string): BacklogLinkList {
  const failure: BacklogLinkList = { ok: false, reason: `GitHub reported an error reading this issue's ${noun}` }
  if (errored) return failure
  const connection = (typeof value === 'object' && value !== null ? value : {}) as { totalCount?: unknown; nodes?: unknown }
  if (typeof connection.totalCount !== 'number' || !Array.isArray(connection.nodes)) return failure
  const items = connection.nodes.map(linkOf).filter((link): link is ClaimBlocker => link !== undefined)
  return { ok: true, items, total: connection.totalCount }
}

function toParentRead(value: unknown, errored: boolean): BacklogParentRead {
  if (errored || value === undefined) return { ok: false, reason: "GitHub reported an error reading this issue's parent" }
  if (value === null) return { ok: true, parent: null }
  const parent = linkOf(value)
  return parent === undefined ? { ok: false, reason: "GitHub reported an error reading this issue's parent" } : { ok: true, parent }
}

interface FetchBacklogDetailParams {
  readonly repo: GitHubRepoRef
  readonly number: number
  readonly github?: GitHubTransport
  readonly now?: () => Date
}

// A failed read is a distinct value; an unreadable issue is `no-data`, never `issue-missing`.
export async function fetchBacklogDetail(params: FetchBacklogDetailParams): Promise<BacklogDetailResponse> {
  const github = params.github ?? githubHttp
  const now = params.now ?? (() => new Date())
  const fetchedAt = now().toISOString()
  const { number } = params
  const slug = `${params.repo.owner}/${params.repo.name}`

  const result = await github(repoGraphqlRequest(buildBacklogDetailQuery(number), params.repo))

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
  const errors = (body.errors ?? []).filter((error) => error.path?.[0] === 'repository' && error.path[1] === 'detail')

  const nodeError = errors.find((error) => error.path?.length === 2)
  if (nodeError !== undefined) {
    if (nodeError.type === 'NOT_FOUND') {
      return { ok: false, kind: 'issue-missing', message: `#${number} does not exist in ${slug}`, fetchedAt }
    }
    return { ok: false, kind: 'no-data', message: `GitHub reported an error reading #${number}: ${nodeError.message}`, fetchedAt }
  }

  const node = repository.detail
  if (typeof node !== 'object' || node === null) {
    return { ok: false, kind: 'issue-missing', message: `#${number} does not exist in ${slug}`, fetchedAt }
  }
  const raw = node as Record<string, unknown>
  if (raw.__typename === 'PullRequest') {
    return { ok: false, kind: 'issue-missing', message: `#${number} is a pull request, not an issue`, fetchedAt }
  }
  if (raw.state !== 'OPEN') {
    return { ok: false, kind: 'issue-closed', message: `#${number} is closed`, fetchedAt }
  }

  const erroredFields = new Set<string>()
  for (const error of errors) {
    const field = error.path?.[2]
    if (typeof field !== 'string' || !LINK_FIELDS.has(field)) {
      return { ok: false, kind: 'no-data', message: `GitHub reported an error reading #${number}: ${error.message}`, fetchedAt }
    }
    erroredFields.add(field)
  }

  const author = (raw.author as { login?: unknown } | null | undefined)?.login
  return {
    ok: true,
    detail: {
      number: typeof raw.number === 'number' ? raw.number : number,
      title: typeof raw.title === 'string' ? raw.title : '',
      url: typeof raw.url === 'string' ? raw.url : '',
      body: typeof raw.body === 'string' ? raw.body : '',
      author: typeof author === 'string' && author !== '' ? author : null,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
      assignees: fieldListOf(raw.assignees, 'login'),
      parent: toParentRead(raw.parent, erroredFields.has('parent')),
      blockedBy: toLinkList(raw.blockedBy, erroredFields.has('blockedBy'), 'blockers'),
      blocking: toLinkList(raw.blocking, erroredFields.has('blocking'), 'blocked issues'),
    },
    fetchedAt,
  }
}
