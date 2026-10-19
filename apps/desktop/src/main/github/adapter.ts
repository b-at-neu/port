import type { EnvelopeFailureKind, GraphQLErrorEntry } from '@/types/github'

// The public logic behind fetchItemStates and the other point reads: building the document, calling
// the injected gh, then composing envelope.ts and map.ts. The pipeline sweep lives in pipeline.ts.
import type { GhResult, GhRunner } from '@/types/platform'
import { gh as defaultGh } from '@/main/platform/gh'
import type { FetchItemsByNumberParams } from '@/types/github'

import type { AssertEqual } from '@/types/assert-type'
import type {
  BlockerRead,
  ClaimBlocker,
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
import { classifyFailure, parseEnvelope, stdoutOf } from '@/main/github/envelope'

import { applyItemStates, fieldListOf } from '@/main/github/map'
import { buildClaimPreflightQuery, buildItemStatesQuery, buildItemsByNumberQuery } from '@/main/github/query'

/** Fails to compile if a failure kind is added to the platform layer or `envelope.ts` without the
 *  hand-maintained, renderer-safe `PipelineFailureKind` growing to match. */
type GhResultFailureKind = Exclude<GhResult, { ok: true }>['kind']
export const _kindsCoverGhResult: AssertEqual<PipelineFailureKind, GhResultFailureKind | EnvelopeFailureKind> = true

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
  readonly gh?: GhRunner
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

  const runner = params.gh ?? defaultGh
  const { document, aliases } = buildItemStatesQuery(params.items)
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

  const runner = params.gh ?? defaultGh
  const { document, aliases } = buildItemsByNumberQuery(params.numbers)
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
    })
  }

  return { ok: true, resolved, unavailable, fetchedAt }
}

interface FetchClaimPreflightParams {
  readonly repo: GitHubRepoRef
  readonly number: number
  readonly gh?: GhRunner
  readonly now?: () => Date
}

/** Reads a `blockedBy` connection into a `BlockerRead`. An unreadable connection is reported by
 *  name rather than folded into an empty list. `shown`/`total` count every node, open or closed. */
function toBlockerRead(value: unknown, errored: boolean): BlockerRead {
  if (errored) return { ok: false, reason: "GitHub reported an error reading this issue's blockers" }
  if (typeof value !== 'object' || value === null) return { ok: false, reason: 'blockedBy is missing from the response' }
  const connection = value as { totalCount?: unknown; nodes?: unknown }
  if (typeof connection.totalCount !== 'number' || !Array.isArray(connection.nodes)) {
    return { ok: false, reason: 'blockedBy is malformed' }
  }
  const open: ClaimBlocker[] = []
  for (const node of connection.nodes) {
    if (typeof node !== 'object' || node === null) continue
    const raw = node as Record<string, unknown>
    const state = typeof raw.state === 'string' ? raw.state : ''
    if (state !== 'OPEN') continue
    open.push({
      number: typeof raw.number === 'number' ? raw.number : 0,
      title: typeof raw.title === 'string' ? raw.title : '',
      url: typeof raw.url === 'string' ? raw.url : '',
      state,
    })
  }
  return { ok: true, open, shown: connection.nodes.length, total: connection.totalCount }
}

/** The claim dialog's one round trip: one item's identity, labels, assignees, open blockers, and
 *  the signed-in login. `item: null` covers "does not exist" or "alias errored", neither a failure. */
export async function fetchClaimPreflight(params: FetchClaimPreflightParams): Promise<ClaimPreflightFetch> {
  const runner = params.gh ?? defaultGh
  const now = params.now ?? (() => new Date())
  const fetchedAt = now().toISOString()

  const { document } = buildClaimPreflightQuery(params.number)
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
