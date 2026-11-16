// The Backlog's per-epic children read: one aliased `issue(number:)` lookup per epic kept in the list.
import { githubHttp } from '@/main/platform/github-http'
import type { GitHubTransport } from '@/types/platform'
import type { BacklogChild, ChildrenRead } from '@/types/backlog'
import type { GitHubRepoRef, GraphQLErrorEntry } from '@/types/github'
import { bodyOf, classifyFailure, parseEnvelope } from '@/main/github/envelope'
import { fieldListOf } from '@/main/github/map'
import { toBlockerRead } from '@/main/github/blockers'
import { blockedByField } from '@/main/github/query'
import { repoGraphqlRequest } from '@/main/github/request'

const CHILD_PAGE_SIZE = 50
const CHILD_LABEL_PAGE_SIZE = 20
const CHILD_BLOCKER_PAGE_SIZE = 10

export const EMPTY_CHILDREN: ChildrenRead = { ok: true, children: [], shown: 0, total: 0 }

export function buildChildrenQuery(numbers: readonly number[]): string {
  const child = `number title state labels(first: ${CHILD_LABEL_PAGE_SIZE}) { nodes { name } } ${blockedByField(CHILD_BLOCKER_PAGE_SIZE)}`
  const fields = numbers.map((number, idx) => `  e${String(idx)}: issue(number: ${String(number)}) { subIssues(first: ${String(CHILD_PAGE_SIZE)}) { totalCount nodes { ${child} } } }`)
  return ['query($owner: String!, $name: String!) {', '  repository(owner: $owner, name: $name) {', ...fields, '  }', '}'].join('\n')
}

function failedAll(numbers: readonly number[], reason: string): ReadonlyMap<number, ChildrenRead> {
  return new Map(numbers.map((number) => [number, { ok: false, reason } satisfies ChildrenRead]))
}

function childOf(node: unknown, errored: boolean, claimedNames: ReadonlySet<string>): BacklogChild | null {
  if (typeof node !== 'object' || node === null) return null
  const raw = node as Record<string, unknown>
  if (typeof raw.number !== 'number' || (raw.state !== 'OPEN' && raw.state !== 'CLOSED')) return null
  return {
    number: raw.number,
    title: typeof raw.title === 'string' ? raw.title : '',
    state: raw.state,
    claimed: fieldListOf(raw.labels, 'name').some((name) => claimedNames.has(name)),
    blockers: toBlockerRead(raw.blockedBy, errored),
  }
}

function epicRead(value: unknown, errors: readonly GraphQLErrorEntry[], alias: string, claimedNames: ReadonlySet<string>): ChildrenRead {
  const own = errors.filter((error) => error.path?.[0] === 'repository' && error.path[1] === alias)
  const isChildBlockedBy = (path: readonly (string | number)[]): boolean => path.length === 6 && path[2] === 'subIssues' && path[3] === 'nodes' && typeof path[4] === 'number' && path[5] === 'blockedBy'
  const blockerErrored = (index: number): boolean => own.some((error) => isChildBlockedBy(error.path ?? []) && error.path?.[4] === index)
  if (own.some((error) => !isChildBlockedBy(error.path ?? []))) return { ok: false, reason: "GitHub reported an error reading this epic's sub-issues" }

  const connection = (value as { subIssues?: unknown } | null | undefined)?.subIssues
  if (typeof connection !== 'object' || connection === null) return { ok: false, reason: 'subIssues is missing from the response' }
  const { totalCount, nodes } = connection as { totalCount?: unknown; nodes?: unknown }
  if (typeof totalCount !== 'number' || !Array.isArray(nodes)) return { ok: false, reason: 'subIssues is malformed' }

  const children: BacklogChild[] = []
  for (const [index, node] of nodes.entries()) {
    const child = childOf(node, blockerErrored(index), claimedNames)
    if (child !== null) children.push(child)
  }
  return { ok: true, children, shown: nodes.length, total: totalCount }
}

interface ChildrenParams {
  readonly repo: GitHubRepoRef
  readonly epics: readonly number[]
  readonly claimedNames: ReadonlySet<string>
  readonly github?: GitHubTransport
}

/** A failure is always per epic and typed, never an empty list; the list read around it stays good. */
export async function fetchChildren(params: ChildrenParams): Promise<ReadonlyMap<number, ChildrenRead>> {
  const { epics } = params
  if (epics.length === 0) return new Map()
  const github = params.github ?? githubHttp

  const result = await github(repoGraphqlRequest(buildChildrenQuery(epics), params.repo))
  const text = bodyOf(result)
  const parsed = text !== undefined ? parseEnvelope(text) : undefined
  const verdict = classifyFailure(result, parsed)
  if (verdict.kind !== 'ok') return failedAll(epics, `Couldn't read this epic's sub-issues: ${verdict.message}`)
  if (parsed === undefined || !parsed.ok) return failedAll(epics, "Couldn't read this epic's sub-issues: no parsed response")

  const repository = parsed.value.data?.repository as Readonly<Record<string, unknown>> | null | undefined
  if (repository === undefined || repository === null) return failedAll(epics, "Couldn't read this epic's sub-issues: no repository data")
  const errors = parsed.value.errors ?? []
  return new Map(epics.map((number, idx) => [number, epicRead(repository[`e${String(idx)}`], errors, `e${String(idx)}`, params.claimedNames)]))
}
