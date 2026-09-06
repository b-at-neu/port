// The public logic behind `fetchPipelineItems`/`fetchItemStates` — building
// the document, calling the injected `gh`, then composing `envelope.ts` and
// `map.ts`. Never reads a config and never calls `resolveVocabulary` itself;
// the caller supplies #75's `LabelVocabulary`.
import type { GhOptions, GhResult } from '../platform/gh'
import { gh as defaultGh } from '../platform/gh'
import { verifyVocabulary } from '../../shared/labels/vocabulary'
import type { LabelVocabulary, RepoLabels } from '../../shared/labels/vocabulary'
import type { AssertEqual } from '../../shared/assert-type'
import type {
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
import { buildItemStatesQuery, buildItemsByNumberQuery, buildPipelineQuery } from './query'

/** The injectable seam every call below takes instead of importing `gh`
 *  directly — the same idiom `Spawner` (`platform/run.ts`) and `resolve`
 *  (`platform/run.ts`'s `RunCommandOptions`) already use, so `adapter.test.ts`
 *  runs against a fake `GhRunner` and needs no real `gh` binary. */
export type GhRunner = (args: readonly string[], options?: GhOptions) => Promise<GhResult>

/** Fails to compile if a failure kind is added to the platform layer (a new
 *  `CommandResult`/`GhClassification` member) or to `envelope.ts`'s own
 *  `EnvelopeFailureKind` without the hand-maintained, renderer-safe
 *  `PipelineFailureKind` growing to match — see `shared/github/types.ts`'s
 *  own comment on why that union can't be derived instead. */
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

interface RepoLabelsConnection {
  readonly totalCount?: unknown
  readonly nodes?: unknown
}

/** `repoLabels` truncation is reported as `unverified`, never as a
 *  confidently-short list — a repository with more than 100 labels would
 *  otherwise report a correctly-resolved name as missing (plan, **Data &
 *  contracts**). */
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

/** Every `errors[].path` entry beside `"repository"`, as the set of unusable
 *  alias names — shared by both fetch functions' failure short-circuits. */
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

/** One `gh api graphql` round trip returning every pipeline item, the
 *  repository's real label list, and the rate-limit budget together. Never
 *  filters the reply server-side — `gh` silently skips that filter on the
 *  exact partial-error response this adapter most needs to read (Decision
 *  3), so the envelope is always parsed here in full instead. */
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
  // classifyFailure's own contract: 'ok' is returned only when `parsed` holds
  // a usable `data.repository` — re-checked here rather than asserted, so a
  // contract violation is a reported value, never a thrown or unsafely cast one.
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

  return {
    ok: true,
    items,
    queried: aliases,
    disabled: params.vocabulary.disabled,
    vocabulary,
    unavailable,
    truncated,
    rateLimit,
    fetchedAt,
  }
}

export interface FetchItemStatesParams {
  readonly repo: RepoRef
  readonly items: readonly ItemRef[]
  readonly gh?: GhRunner
  readonly now?: () => Date
}

/** The reconciliation primitive: never infer "still awaiting merge" from a
 *  cached open-sweep list, re-check state. The caller supplies each item's
 *  `kind`, so no alias here is guaranteed to 404 — a number that has
 *  genuinely vanished comes back in `unavailable`, never silently dropped
 *  or read as still open. */
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

/**
 * The re-check primitive for a number a worktree or an agent record merely
 * names (#79 Decision 4): never infer "still awaiting merge" from a cached
 * open-sweep list. The kind is read off each node's own `__typename`, since
 * the caller does not know it — unlike `fetchItemStates`, whose caller
 * already does. An empty `numbers` short-circuits to `ok: true` with no
 * round trip.
 */
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
    })
  }

  return { ok: true, resolved, unavailable, fetchedAt }
}

export { applyItemStates }
