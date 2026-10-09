// The public logic behind fetchPipelineItems/fetchItemStates: building the document, calling the
// injected gh, then composing envelope.ts and map.ts. The caller supplies the LabelVocabulary.
import type { GhResult, GhRunner } from '../platform/gh'
import { gh as defaultGh } from '../platform/gh'

export type { GhRunner }
import { verifyVocabulary } from '../../shared/labels/vocabulary'
import type { LabelVocabulary, RepoLabels } from '../../shared/labels/vocabulary'
import type { AssertEqual } from '../../shared/assert-type'
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
  PipelineFetch,
  PipelineItemKind,
  RateLimitInfo,
  ResolvedItem,
} from '../../shared/github/types'
import { classifyFailure, collectTruncated, collectUnavailable, parseEnvelope } from './envelope'
import type { AliasInfo, EnvelopeFailureKind, GraphQLErrorEntry } from './envelope'
import { applyItemStates, fieldListOf, mapPipelineItems } from './map'
import { buildClaimPreflightQuery, buildItemStatesQuery, buildItemsByNumberQuery, buildPipelineQuery } from './query'

/** Fails to compile if a failure kind is added to the platform layer or `envelope.ts` without the
 *  hand-maintained, renderer-safe `PipelineFailureKind` growing to match. */
type GhResultFailureKind = Exclude<GhResult, { ok: true }>['kind']
export const _kindsCoverGhResult: AssertEqual<PipelineFailureKind, GhResultFailureKind | EnvelopeFailureKind> = true

function toRateLimit(value: unknown): RateLimitInfo {
  if (typeof value !== 'object' || value === null) return { cost: 0, remaining: 0, resetAt: '' }
  const raw = value as Record<string, unknown>
  return {
    cost: typeof raw.cost === 'number' ? raw.cost : 0,
    remaining: typeof raw.remaining === 'number' ? raw.remaining : 0,
    resetAt: typeof raw.resetAt === 'string' ? raw.resetAt : '',
  }
}

/** `null`, never a guess, when the alias is absent, malformed, or named in `errors[].path`.
 *  Unlike `fetchClaimPreflight`'s `viewerLogin`, this never fails the whole fetch. */
function toViewer(value: unknown, errors: readonly GraphQLErrorEntry[] | undefined): string | null {
  if ((errors ?? []).some((error) => error.path?.[0] === 'viewer')) return null
  if (typeof value !== 'object' || value === null) return null
  const login = (value as Record<string, unknown>).login
  return typeof login === 'string' && login !== '' ? login : null
}

interface RepoLabelsConnection {
  readonly totalCount?: unknown
  readonly nodes?: unknown
}

/** `repoLabels` truncation is reported as `unverified`, never as a confidently-short list. */
function toRepoLabels(value: unknown): RepoLabels {
  if (typeof value !== 'object' || value === null) return { ok: false, reason: 'repoLabels alias missing from the response' }
  const connection = value as RepoLabelsConnection
  const totalCount = connection.totalCount
  const nodes = connection.nodes
  if (typeof totalCount !== 'number' || !Array.isArray(nodes)) {
    return { ok: false, reason: 'repoLabels alias malformed' }
  }
  if (totalCount > nodes.length) {
    return { ok: false, reason: `label list truncated at ${nodes.length} of ${totalCount}` }
  }
  const names: string[] = []
  for (const node of nodes) {
    if (typeof node === 'object' && node !== null && typeof (node as Record<string, unknown>).name === 'string') {
      names.push((node as Record<string, unknown>).name as string)
    }
  }
  return { ok: true, names }
}

function stdoutOf(result: GhResult): string | undefined {
  return 'stdout' in result ? result.stdout : undefined
}

/** Every `errors[].path` entry beside `"repository"`, as the set of unusable alias names. */
function unavailableAliasNames(errors: readonly GraphQLErrorEntry[] | undefined): ReadonlySet<string> {
  const names = new Set<string>()
  for (const error of errors ?? []) {
    const alias = error.path?.[1]
    if (typeof alias === 'string') names.add(alias)
  }
  return names
}

export interface RepoRef {
  readonly owner: string
  readonly name: string
}

export interface FetchPipelineItemsParams {
  readonly repo: RepoRef
  readonly vocabulary: LabelVocabulary
  readonly gh?: GhRunner
  readonly now?: () => Date
}

/** One `gh api graphql` round trip returning every pipeline item, the repository's real label
 *  list, and the rate-limit budget together. Never filters the reply server-side. */
export async function fetchPipelineItems(params: FetchPipelineItemsParams): Promise<PipelineFetch> {
  const runner = params.gh ?? defaultGh
  const now = params.now ?? (() => new Date())
  const fetchedAt = now().toISOString()

  const { document, aliases } = buildPipelineQuery(params.vocabulary)
  const ghResult = await runner(['api', 'graphql', '-f', `query=${document}`, '-f', `owner=${params.repo.owner}`, '-f', `name=${params.repo.name}`])

  const stdout = stdoutOf(ghResult)
  const parsed = stdout !== undefined ? parseEnvelope(stdout) : undefined
  const verdict = classifyFailure(ghResult, parsed)

  if (verdict.kind !== 'ok') {
    return { ok: false, kind: verdict.kind, message: verdict.message, fetchedAt }
  }
  // Re-checked here rather than asserted, so a contract violation is a reported value, never thrown.
  if (parsed === undefined || !parsed.ok) {
    return { ok: false, kind: 'no-data', message: 'internal: an ok verdict without a parsed envelope', fetchedAt }
  }
  const body = parsed.value
  if (body.data === undefined || body.data === null || body.data.repository === undefined || body.data.repository === null) {
    return { ok: false, kind: 'no-data', message: 'internal: an ok verdict without usable repository data', fetchedAt }
  }
  const repository = body.data.repository as Readonly<Record<string, unknown>>

  const aliasIndex = new Map<string, AliasInfo>()
  for (const alias of aliases) {
    aliasIndex.set(alias.issueAlias, { key: alias.key, name: alias.name, surface: 'issue' })
    aliasIndex.set(alias.prAlias, { key: alias.key, name: alias.name, surface: 'pull-request' })
  }

  const unavailable = collectUnavailable(body.errors, aliasIndex)
  const truncated = collectTruncated(repository, aliasIndex)
  const repo = `${params.repo.owner}/${params.repo.name}`
  const items = mapPipelineItems(repository, aliases, repo)
  const vocabulary = verifyVocabulary(params.vocabulary, toRepoLabels(repository.repoLabels))
  const rateLimit = toRateLimit(body.data.rateLimit)
  const viewer = toViewer(body.data.viewer, body.errors)

  return {
    ok: true,
    items,
    queried: aliases,
    disabled: params.vocabulary.disabled,
    vocabulary,
    unavailable,
    truncated,
    rateLimit,
    viewer,
    fetchedAt,
  }
}

export interface FetchItemStatesParams {
  readonly repo: RepoRef
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

export interface FetchItemsByNumberParams {
  readonly repo: RepoRef
  readonly numbers: readonly number[]
  readonly gh?: GhRunner
  readonly now?: () => Date
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

export interface FetchClaimPreflightParams {
  readonly repo: RepoRef
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
