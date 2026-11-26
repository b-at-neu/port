// The read loops both halves of the board read share: the reply check, the rate-limit sum, a paged
// one-surface sweep, and the chunked by-number and detail reads.
import type { GitHubTransport } from '@/types/platform'
import type { LabelVocabulary } from '@/utils/labels/vocabulary'
import type { AliasInfo, GitHubRepoRef, GraphQLErrorEntry, ItemDetail, PipelineFailureKind, PipelineItem, PipelineItemKind, RateLimitInfo, SweepAlias, SweepPage, TruncatedSet, UnavailableAlias } from '@/types/github'
import type { TrackedRef } from '@/types/pipeline-state'
import { bodyOf, classifyFailure, collectUnavailable, parseEnvelope } from '@/main/github/envelope'
import { mapTrackedItem } from '@/main/github/map'
import type { NumberedQuery } from '@/main/github/query'
import { repoGraphqlRequest } from '@/main/github/request'

const MAX_SWEEP_PAGES = 10
const DETAIL_CHUNK_SIZE = 100

const ALIAS_INDEX: ReadonlyMap<SweepAlias, AliasInfo> = new Map<SweepAlias, AliasInfo>([
  ['issues', { surface: 'issue' }],
  ['pullRequests', { surface: 'pull-request' }],
])

export const NO_RATE_LIMIT: RateLimitInfo = { cost: 0, remaining: 0, resetAt: '', limit: 0 }

export interface ReadFailure {
  readonly ok: false
  readonly kind: PipelineFailureKind
  readonly message: string
}

export interface OkReply {
  readonly ok: true
  readonly data: Readonly<Record<string, unknown>>
  readonly repository: Readonly<Record<string, unknown>>
  readonly errors: readonly GraphQLErrorEntry[] | undefined
}

export function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null ? (value as Readonly<Record<string, unknown>>) : undefined
}

/** `undefined`, never zeros, when the reply carried no `rateLimit` at all. */
function readRateLimit(value: unknown): RateLimitInfo | undefined {
  const raw = asRecord(value)
  if (raw === undefined) return undefined
  return {
    cost: typeof raw.cost === 'number' ? raw.cost : 0,
    remaining: typeof raw.remaining === 'number' ? raw.remaining : 0,
    resetAt: typeof raw.resetAt === 'string' ? raw.resetAt : '',
    limit: typeof raw.limit === 'number' ? raw.limit : 0,
  }
}

/** `cost` sums every round trip; the other fields come from the last reply that carried them. */
export function addRateLimit(total: RateLimitInfo, reply: unknown): RateLimitInfo {
  const read = readRateLimit(reply)
  if (read === undefined) return total
  return { ...read, cost: total.cost + read.cost }
}

/** `cost` sums; the budget fields come from the half that read the lower `remaining`, which replied later. A half that read none (`limit` 0) yields to the other. */
export function mergeRateLimit(a: RateLimitInfo, b: RateLimitInfo): RateLimitInfo {
  const cost = a.cost + b.cost
  if (a.limit === 0) return { ...b, cost }
  if (b.limit === 0) return { ...a, cost }
  return { ...(b.remaining < a.remaining ? b : a), cost }
}

export async function graphql(github: GitHubTransport, repo: GitHubRepoRef, document: string): Promise<OkReply | ReadFailure> {
  const result = await github(repoGraphqlRequest(document, repo))
  const text = bodyOf(result)
  const parsed = text !== undefined ? parseEnvelope(text) : undefined
  const verdict = classifyFailure(result, parsed)

  if (verdict.kind !== 'ok') return { ok: false, kind: verdict.kind, message: verdict.message }
  // Re-checked here rather than asserted, so a contract violation is a reported value, never thrown.
  if (parsed === undefined || !parsed.ok) return { ok: false, kind: 'no-data', message: 'internal: an ok verdict without a parsed envelope' }
  const body = parsed.value
  const repository = asRecord(body.data?.repository)
  if (body.data === undefined || body.data === null || repository === undefined) {
    return { ok: false, kind: 'no-data', message: 'internal: an ok verdict without usable repository data' }
  }
  return { ok: true, data: body.data, repository, errors: body.errors }
}

interface SweepSurface {
  readonly alias: SweepAlias
  readonly build: (page: SweepPage) => string
  /** False asks for page one only, without the connection: an empty `labels:` list filters nothing. */
  readonly connection: boolean
}

export interface SweepRead {
  readonly ok: true
  readonly nodes: readonly unknown[]
  readonly unavailable: readonly UnavailableAlias[]
  readonly truncated: readonly TruncatedSet[]
  readonly rateLimit: RateLimitInfo
  /** Page one's reply, so each half reads its own first-page fields off it. */
  readonly first: OkReply
}

/** Pages one connection to the cap. A connection named in `errors[].path` or malformed is `unavailable`, never read as empty. */
export async function sweepSurface(github: GitHubTransport, repo: GitHubRepoRef, surface: SweepSurface): Promise<SweepRead | ReadFailure> {
  const { alias } = surface
  const surfaceKind: PipelineItemKind = ALIAS_INDEX.get(alias)?.surface ?? 'issue'
  const nodes: unknown[] = []
  let totalCount = 0
  let page: SweepPage = { connection: surface.connection, after: null }
  let rateLimit = NO_RATE_LIMIT
  let unavailable: readonly UnavailableAlias[] = []
  let truncated: readonly TruncatedSet[] = []

  const first = await graphql(github, repo, surface.build(page))
  if (!first.ok) return first
  let reply: OkReply = first

  for (let fetched = 1; ; fetched++) {
    rateLimit = addRateLimit(rateLimit, reply.data.rateLimit)
    if (!page.connection) break

    const named = collectUnavailable(reply.errors, ALIAS_INDEX).find((entry) => entry.alias === alias)
    const connection = asRecord(reply.repository[alias])
    const received = connection?.nodes
    if (named !== undefined || connection === undefined || !Array.isArray(received)) {
      unavailable = [named ?? { alias, surface: surfaceKind }]
      break
    }
    for (const entry of received) nodes.push(entry)
    if (typeof connection.totalCount === 'number') totalCount = connection.totalCount
    const pageInfo = asRecord(connection.pageInfo)
    if (pageInfo?.hasNextPage !== true || typeof pageInfo.endCursor !== 'string') break
    if (fetched >= MAX_SWEEP_PAGES) {
      truncated = [{ alias, surface: surfaceKind, totalCount, received: nodes.length }]
      break
    }
    page = { connection: true, after: pageInfo.endCursor }
    const next = await graphql(github, repo, surface.build(page))
    if (!next.ok) return next
    reply = next
  }

  return { ok: true, nodes, unavailable, truncated, rateLimit, first }
}

/** The tracked refs the sweep found, with the store's keys applied, and the ones it did not. */
export function selectTracked(swept: readonly PipelineItem[], refs: readonly TrackedRef[]): { readonly kept: readonly PipelineItem[]; readonly missing: readonly TrackedRef[] } {
  const tracked = new Map(refs.map((ref) => [`${ref.kind}:${String(ref.number)}`, ref]))
  const kept = swept.flatMap((item) => {
    const ref = tracked.get(`${item.kind}:${String(item.number)}`)
    return ref === undefined ? [] : [{ ...item, matchedKeys: ref.keys }]
  })
  const seen = new Set(kept.map((item) => `${item.kind}:${String(item.number)}`))
  return { kept, missing: refs.filter((ref) => !seen.has(`${ref.kind}:${String(ref.number)}`)) }
}

export interface TrackedRead {
  readonly ok: true
  readonly items: readonly PipelineItem[]
  readonly closed: readonly number[]
  readonly merged: readonly number[]
  readonly rateLimit: RateLimitInfo
}

/** An alias GitHub reports as not found is gone for good, so it is closed; any other error or a malformed node fails the whole read, the same rule as the detail read. A closed pull request with `mergedAt` is also merged. */
export async function readTrackedChunks(
  github: GitHubTransport,
  repo: GitHubRepoRef,
  vocabulary: LabelVocabulary,
  kind: PipelineItemKind,
  refs: readonly TrackedRef[],
  rateLimit: RateLimitInfo,
  build: (numbers: readonly number[]) => NumberedQuery,
): Promise<TrackedRead | ReadFailure> {
  const items: PipelineItem[] = []
  const closed: number[] = []
  const merged: number[] = []
  let total = rateLimit
  for (let start = 0; start < refs.length; start += DETAIL_CHUNK_SIZE) {
    const chunk = refs.slice(start, start + DETAIL_CHUNK_SIZE)
    const { document, aliases } = build(chunk.map((ref) => ref.number))
    const reply = await graphql(github, repo, document)
    if (!reply.ok) return reply
    total = addRateLimit(total, reply.data.rateLimit)
    const errors = reply.errors ?? []
    for (const [idx, alias] of aliases.entries()) {
      const node = asRecord(reply.repository[alias.alias])
      const own = errors.filter((error) => error.path?.[1] === alias.alias)
      if (node === undefined && own.length > 0 && own.every((error) => error.type === 'NOT_FOUND')) {
        closed.push(alias.number)
        continue
      }
      const item = node === undefined || own.length > 0 ? undefined : mapTrackedItem(node, kind, vocabulary, `${repo.owner}/${repo.name}`, chunk[idx]?.keys ?? [])
      if (item === undefined) return { ok: false, kind: 'no-data', message: `the read of tracked ${kind} #${alias.number} came back empty` }
      if (item.state === 'OPEN') {
        items.push(item)
        continue
      }
      closed.push(alias.number)
      if (item.kind === 'pull-request' && item.mergedAt !== null) merged.push(alias.number)
    }
  }
  return { ok: true, items, closed, merged, rateLimit: total }
}

export interface DetailRead {
  readonly ok: true
  readonly details: readonly ItemDetail[]
  readonly rateLimit: RateLimitInfo
}

interface DetailSpec<T> {
  readonly kind: PipelineItemKind
  readonly items: readonly T[]
  readonly build: (chunk: readonly T[]) => NumberedQuery
  /** Fields whose own error costs a tag, never the board. Any other alias error, or a null node, fails the whole read: a missing review list would read as zero cycles, and a revise dispatch could go past the cap. */
  readonly perField: ReadonlySet<unknown>
}

export async function readDetailChunks<T>(github: GitHubTransport, repo: GitHubRepoRef, rateLimit: RateLimitInfo, spec: DetailSpec<T>): Promise<DetailRead | ReadFailure> {
  const details: ItemDetail[] = []
  let total = rateLimit
  for (let start = 0; start < spec.items.length; start += DETAIL_CHUNK_SIZE) {
    const { document, aliases } = spec.build(spec.items.slice(start, start + DETAIL_CHUNK_SIZE))
    const reply = await graphql(github, repo, document)
    if (!reply.ok) return reply
    total = addRateLimit(total, reply.data.rateLimit)
    const errors = reply.errors ?? []
    for (const alias of aliases) {
      const node = reply.repository[alias.alias]
      const own = errors.filter((error) => error.path?.[1] === alias.alias)
      const perField = own.filter((error) => spec.perField.has(error.path?.[2]))
      if (own.length > perField.length || asRecord(node) === undefined) {
        return { ok: false, kind: 'no-data', message: `the detail read for ${spec.kind} #${alias.number} came back empty` }
      }
      details.push({ kind: spec.kind, number: alias.number, node, erroredFields: perField.map((error) => String(error.path?.[2])) })
    }
  }
  return { ok: true, details, rateLimit: total }
}
