import type { EnvelopeFailureKind, GraphQLErrorEntry } from '@/types/github'

// The public logic behind fetchItemStates and the other point reads: building the document, calling
// the injected transport, then composing envelope.ts and map.ts. The pipeline sweep lives in pipeline.ts.
import type { GitHubHttpResult, GitHubTransport } from '@/types/platform'
import { githubHttp } from '@/main/platform/github-http'
import type { FetchItemsByNumberParams } from '@/types/github'

import type { AssertEqual } from '@/types/assert-type'
import type {
  ClaimPreflightFetch,
  ClaimPreflightItem,
  ItemRef,
  ItemsByNumberFetch,
  ItemState,
  ItemStatesFetch,
  PipelineFailureKind,
  PipelineItemKind,
  GitHubRepoRef,
  ResolvedItem,
} from '@/types/github'
import { bodyOf, classifyFailure, parseEnvelope } from '@/main/github/envelope'
import { toBlockerRead } from '@/main/github/blockers'

import { applyItemStates, fieldListOf } from '@/main/github/map'
import { buildClaimPreflightQuery, buildItemStatesQuery, buildItemsByNumberQuery } from '@/main/github/query'
import { repoGraphqlRequest } from '@/main/github/request'

/** Fails to compile if a failure kind is added to the platform layer or `envelope.ts` without the
 *  hand-maintained, renderer-safe `PipelineFailureKind` growing to match. */
type GitHubHttpFailureKind = Exclude<GitHubHttpResult, { ok: true }>['kind']
export const _kindsCoverGitHubHttp: AssertEqual<PipelineFailureKind, GitHubHttpFailureKind | EnvelopeFailureKind> = true

/** Every `errors[].path` entry beside `"repository"`, as the set of unusable alias names. */
function unavailableAliasNames(errors: readonly GraphQLErrorEntry[] | undefined): ReadonlySet<string> {
  const names = new Set<string>()
  for (const error of errors ?? []) {
    const alias = error.path?.[1]
    if (typeof alias === 'string') names.add(alias)
  }
  return names
}

interface FetchItemStatesParams {
  readonly repo: GitHubRepoRef
  readonly items: readonly ItemRef[]
  readonly github?: GitHubTransport
  readonly now?: () => Date
}

/** The reconciliation primitive: never infer "still awaiting merge" from a cached open-sweep
 *  list, re-check state. A vanished number comes back in `unavailable`, never silently dropped. */
export async function fetchItemStates(params: FetchItemStatesParams): Promise<ItemStatesFetch> {
  const now = params.now ?? (() => new Date())
  const fetchedAt = now().toISOString()

  if (params.items.length === 0) {
    return { ok: true, states: [], unavailable: [], fetchedAt }
  }

  const github = params.github ?? githubHttp
  const { document, aliases } = buildItemStatesQuery(params.items)
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
  const errorAliases = unavailableAliasNames(body.errors)

  const states: ItemState[] = []
  const unavailable: ItemRef[] = []
  for (const alias of aliases) {
    if (errorAliases.has(alias.alias)) {
      unavailable.push({ kind: alias.kind, number: alias.number })
      continue
    }
    const node = repository[alias.alias]
    if (typeof node !== 'object' || node === null) {
      unavailable.push({ kind: alias.kind, number: alias.number })
      continue
    }
    const raw = node as Record<string, unknown>
    states.push({
      kind: alias.kind,
      number: alias.number,
      state: typeof raw.state === 'string' ? raw.state : '',
      mergedAt: typeof raw.mergedAt === 'string' ? raw.mergedAt : null,
      closedAt: typeof raw.closedAt === 'string' ? raw.closedAt : null,
      url: typeof raw.url === 'string' ? raw.url : '',
    })
  }

  return { ok: true, states, unavailable, fetchedAt }
}

function kindOfTypename(typename: unknown): PipelineItemKind | undefined {
  if (typename === 'Issue') return 'issue'
  if (typename === 'PullRequest') return 'pull-request'
  return undefined
}

/** The re-check primitive for a number a worktree or agent record merely names. The kind is read
 *  off each node's own `__typename`. An empty `numbers` short-circuits with no round trip. */
export async function fetchItemsByNumber(params: FetchItemsByNumberParams): Promise<ItemsByNumberFetch> {
  const now = params.now ?? (() => new Date())
  const fetchedAt = now().toISOString()

  if (params.numbers.length === 0) {
    return { ok: true, resolved: [], unavailable: [], fetchedAt }
  }

  const github = params.github ?? githubHttp
  const { document, aliases } = buildItemsByNumberQuery(params.numbers)
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
  const errorAliases = unavailableAliasNames(body.errors)

  const resolved: ResolvedItem[] = []
  const unavailable: number[] = []
  for (const alias of aliases) {
    if (errorAliases.has(alias.alias)) {
      unavailable.push(alias.number)
      continue
    }
    const node = repository[alias.alias]
    const kind = typeof node === 'object' && node !== null ? kindOfTypename((node as Record<string, unknown>).__typename) : undefined
    if (kind === undefined) {
      unavailable.push(alias.number)
      continue
    }
    const raw = node as Record<string, unknown>
    resolved.push({
      number: alias.number,
      kind,
      state: typeof raw.state === 'string' ? raw.state : '',
      mergedAt: typeof raw.mergedAt === 'string' ? raw.mergedAt : null,
      closedAt: typeof raw.closedAt === 'string' ? raw.closedAt : null,
      title: typeof raw.title === 'string' ? raw.title : '',
      url: typeof raw.url === 'string' ? raw.url : '',
      labels: fieldListOf(raw.labels, 'name'),
      assignees: fieldListOf(raw.assignees, 'login'),
      headRefName: kind === 'pull-request' && typeof raw.headRefName === 'string' ? raw.headRefName : null,
      author: kind === 'pull-request' ? authorLoginOf(raw.author) : null,
    })
  }

  return { ok: true, resolved, unavailable, fetchedAt }
}

function authorLoginOf(author: unknown): string | null {
  if (typeof author !== 'object' || author === null) return null
  const login = (author as Record<string, unknown>).login
  return typeof login === 'string' ? login : null
}

interface FetchClaimPreflightParams {
  readonly repo: GitHubRepoRef
  readonly number: number
  readonly github?: GitHubTransport
  readonly now?: () => Date
}

/** The claim dialog's one round trip: one item's identity, labels, assignees, open blockers, and
 *  the signed-in login. `item: null` covers "does not exist" or "alias errored", neither a failure. */
export async function fetchClaimPreflight(params: FetchClaimPreflightParams): Promise<ClaimPreflightFetch> {
  const github = params.github ?? githubHttp
  const now = params.now ?? (() => new Date())
  const fetchedAt = now().toISOString()

  const { document } = buildClaimPreflightQuery(params.number)
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
  if (viewerErrored || typeof viewerLogin !== 'string' || viewerLogin === '') {
    return { ok: false, kind: 'no-data', message: "could not resolve the signed-in account's login", fetchedAt }
  }

  const itemErrored = errors.some((error) => error.path?.[1] === 'c0' && error.path.length === 2)
  const node = repository.c0
  const kind = itemErrored || typeof node !== 'object' || node === null ? undefined : kindOfTypename((node as Record<string, unknown>).__typename)
  if (kind === undefined) {
    return { ok: true, item: null, viewer: viewerLogin, fetchedAt }
  }
  const raw = node as Record<string, unknown>

  const blockersErrored = errors.some((error) => error.path?.[1] === 'c0' && error.path[2] === 'blockedBy')
  const item: ClaimPreflightItem = {
    kind,
    number: typeof raw.number === 'number' ? raw.number : params.number,
    title: typeof raw.title === 'string' ? raw.title : '',
    url: typeof raw.url === 'string' ? raw.url : '',
    state: typeof raw.state === 'string' ? raw.state : '',
    labels: kind === 'issue' ? fieldListOf(raw.labels, 'name') : [],
    assignees: kind === 'issue' ? fieldListOf(raw.assignees, 'login') : [],
    blockers: kind === 'issue' ? toBlockerRead(raw.blockedBy, blockersErrored) : { ok: true, open: [], shown: 0, total: 0 },
  }

  return { ok: true, item, viewer: viewerLogin, fetchedAt }
}

export { applyItemStates }
