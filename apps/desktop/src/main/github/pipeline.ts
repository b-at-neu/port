// The pipeline read: a paged two-connection sweep for the light fields, then a per-number detail
// read for the heavy ones. Cost stays flat in the number of enabled labels.
import type { GhRunner } from '@/types/platform'
import { gh as defaultGh } from '@/main/platform/gh'
import { verifyVocabulary } from '@/utils/labels/vocabulary'
import type { LabelVocabulary, RepoLabels } from '@/utils/labels/vocabulary'
import type {
  AliasInfo,
  GitHubRepoRef,
  GraphQLErrorEntry,
  ItemDetail,
  PipelineFailureKind,
  PipelineFetch,
  PipelineItem,
  PipelineItemKind,
  QueriedLabel,
  RateLimitInfo,
  SweepAlias,
  SweepPage,
  TruncatedSet,
  UnavailableAlias,
} from '@/types/github'
import { classifyFailure, collectUnavailable, parseEnvelope, stdoutOf } from '@/main/github/envelope'
import { applyItemDetails, mapPipelineItems } from '@/main/github/map'
import { FIRST_SWEEP_PAGE, buildItemDetailsQuery, buildPipelineQuery } from '@/main/github/query'

const MAX_SWEEP_PAGES = 10
const DETAIL_CHUNK_SIZE = 100

const ALIAS_INDEX: ReadonlyMap<SweepAlias, AliasInfo> = new Map<SweepAlias, AliasInfo>([
  ['issues', { surface: 'issue' }],
  ['pullRequests', { surface: 'pull-request' }],
])

type Failure = { readonly ok: false; readonly kind: PipelineFailureKind; readonly message: string }

type Reply =
  | { readonly ok: true; readonly data: Readonly<Record<string, unknown>>; readonly repository: Readonly<Record<string, unknown>>; readonly errors: readonly GraphQLErrorEntry[] | undefined }
  | Failure

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
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
function addRateLimit(total: RateLimitInfo, reply: unknown): RateLimitInfo {
  const read = readRateLimit(reply)
  if (read === undefined) return total
  return { ...read, cost: total.cost + read.cost }
}

/** `null`, never a guess, when the alias is absent, malformed, or named in `errors[].path`.
 *  Unlike `fetchClaimPreflight`'s `viewerLogin`, this never fails the whole fetch. */
function toViewer(value: unknown, errors: readonly GraphQLErrorEntry[] | undefined): string | null {
  if ((errors ?? []).some((error) => error.path?.[0] === 'viewer')) return null
  const login = asRecord(value)?.login
  return typeof login === 'string' && login !== '' ? login : null
}

/** `repoLabels` truncation is reported as `unverified`, never as a confidently-short list. */
function toRepoLabels(value: unknown): RepoLabels {
  const connection = asRecord(value)
  if (connection === undefined) return { ok: false, reason: 'repoLabels alias missing from the response' }
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
    const name = asRecord(node)?.name
    if (typeof name === 'string') names.push(name)
  }
  return { ok: true, names }
}

async function graphql(runner: GhRunner, repo: GitHubRepoRef, document: string): Promise<Reply> {
  const ghResult = await runner(['api', 'graphql', '-f', `query=${document}`, '-f', `owner=${repo.owner}`, '-f', `name=${repo.name}`])
  const stdout = stdoutOf(ghResult)
  const parsed = stdout !== undefined ? parseEnvelope(stdout) : undefined
  const verdict = classifyFailure(ghResult, parsed)

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

interface SweepState {
  readonly nodes: Record<SweepAlias, unknown[]>
  readonly totals: Record<SweepAlias, number>
  readonly unavailable: Map<SweepAlias, UnavailableAlias>
}

const SWEEP_ALIASES: readonly SweepAlias[] = ['issues', 'pullRequests']

function surfaceOf(alias: SweepAlias): PipelineItemKind {
  return alias === 'issues' ? 'issue' : 'pull-request'
}

/** Folds one reply's connections into `state`, returning the cursor each still-open surface resumes at. */
function absorbSweepPage(reply: Extract<Reply, { ok: true }>, requested: ReadonlySet<SweepAlias>, state: SweepState): Readonly<Record<SweepAlias, string | null>> {
  const unavailable = collectUnavailable(reply.errors, ALIAS_INDEX)
  const next: Record<SweepAlias, string | null> = { issues: null, pullRequests: null }
  for (const alias of SWEEP_ALIASES) {
    if (!requested.has(alias)) continue
    const named = unavailable.find((entry) => entry.alias === alias)
    const connection = asRecord(reply.repository[alias])
    const nodes = connection?.nodes
    if (named !== undefined || connection === undefined || !Array.isArray(nodes)) {
      state.unavailable.set(alias, named ?? { alias, surface: surfaceOf(alias) })
      continue
    }
    for (const raw of nodes) state.nodes[alias].push(raw)
    if (typeof connection.totalCount === 'number') state.totals[alias] = connection.totalCount
    const pageInfo = asRecord(connection.pageInfo)
    if (pageInfo?.hasNextPage === true && typeof pageInfo.endCursor === 'string') next[alias] = pageInfo.endCursor
  }
  return next
}

interface SweepResult {
  readonly state: SweepState
  readonly rateLimit: RateLimitInfo
  readonly viewer: string | null
  readonly repoLabels: RepoLabels
  readonly truncated: readonly TruncatedSet[]
}

async function sweep(runner: GhRunner, repo: GitHubRepoRef, vocabulary: LabelVocabulary): Promise<SweepResult | Failure> {
  const state: SweepState = { nodes: { issues: [], pullRequests: [] }, totals: { issues: 0, pullRequests: 0 }, unavailable: new Map() }
  // An empty `labels:` list filters nothing, so with no enabled label the connections are not asked at all.
  const hasLabels = vocabulary.labels.length > 0
  let page: SweepPage = hasLabels ? FIRST_SWEEP_PAGE : { ...FIRST_SWEEP_PAGE, issues: false, pulls: false }
  let rateLimit: RateLimitInfo = { cost: 0, remaining: 0, resetAt: '', limit: 0 }
  let viewer: string | null = null
  let repoLabels: RepoLabels = { ok: false, reason: 'repoLabels alias missing from the response' }
  let truncated: readonly TruncatedSet[] = []

  for (let fetched = 1; ; fetched++) {
    const reply = await graphql(runner, repo, buildPipelineQuery(vocabulary, page))
    if (!reply.ok) return reply
    rateLimit = addRateLimit(rateLimit, reply.data.rateLimit)
    if (fetched === 1) {
      viewer = toViewer(reply.data.viewer, reply.errors)
      repoLabels = toRepoLabels(reply.repository.repoLabels)
    }

    const requested = new Set<SweepAlias>([...(page.issues ? (['issues'] as const) : []), ...(page.pulls ? (['pullRequests'] as const) : [])])
    const next = absorbSweepPage(reply, requested, state)
    page = { issues: next.issues !== null, pulls: next.pullRequests !== null, issuesAfter: next.issues, pullsAfter: next.pullRequests }
    if (!page.issues && !page.pulls) break
    if (fetched >= MAX_SWEEP_PAGES) {
      truncated = SWEEP_ALIASES.filter((alias) => next[alias] !== null).map((alias) => ({ alias, surface: surfaceOf(alias), totalCount: state.totals[alias], received: state.nodes[alias].length }))
      break
    }
  }

  return { state, rateLimit, viewer, repoLabels, truncated }
}

interface DetailsResult {
  readonly details: readonly ItemDetail[]
  readonly rateLimit: RateLimitInfo
}

/** Any detail alias that errors or comes back null fails the whole read: a missing review list would
 *  read as zero cycles, and a revise dispatch could go past the cap. */
async function readDetails(runner: GhRunner, repo: GitHubRepoRef, items: readonly PipelineItem[], rateLimit: RateLimitInfo): Promise<DetailsResult | Failure> {
  const refs = items.map((item) => ({ kind: item.kind, number: item.number, rollup: item.kind === 'pull-request' && item.matchedKeys.includes('approved') }))
  const details: ItemDetail[] = []
  let total = rateLimit

  for (let start = 0; start < refs.length; start += DETAIL_CHUNK_SIZE) {
    const { document, aliases } = buildItemDetailsQuery(refs.slice(start, start + DETAIL_CHUNK_SIZE))
    const reply = await graphql(runner, repo, document)
    if (!reply.ok) return reply
    total = addRateLimit(total, reply.data.rateLimit)
    const errored = new Set((reply.errors ?? []).map((error) => error.path?.[1]))
    for (const alias of aliases) {
      const node = reply.repository[alias.alias]
      if (errored.has(alias.alias) || asRecord(node) === undefined) {
        return { ok: false, kind: 'no-data', message: `the detail read for ${alias.kind} #${alias.number} came back empty` }
      }
      details.push({ kind: alias.kind, number: alias.number, node })
    }
  }

  return { details, rateLimit: total }
}

interface FetchPipelineItemsParams {
  readonly repo: GitHubRepoRef
  readonly vocabulary: LabelVocabulary
  readonly gh?: GhRunner
  readonly now?: () => Date
}

function queriedLabelsOf(vocabulary: LabelVocabulary): readonly QueriedLabel[] {
  return vocabulary.labels.map((label) => ({ key: label.key, name: label.name, source: label.source }))
}

/** Every pipeline item, the repository's real label list, and the rate-limit cost together. Never
 *  filters the reply server-side, and no path returns an empty list for a read that did not succeed. */
export async function fetchPipelineItems(params: FetchPipelineItemsParams): Promise<PipelineFetch> {
  const runner = params.gh ?? defaultGh
  const now = params.now ?? (() => new Date())
  const fetchedAt = now().toISOString()
  const repo = `${params.repo.owner}/${params.repo.name}`

  const swept = await sweep(runner, params.repo, params.vocabulary)
  if ('ok' in swept) return { ...swept, fetchedAt }

  const light = SWEEP_ALIASES.flatMap((alias) => mapPipelineItems(swept.state.nodes[alias], surfaceOf(alias), params.vocabulary, repo))
  const detailed = await readDetails(runner, params.repo, light, swept.rateLimit)
  if ('ok' in detailed) return { ...detailed, fetchedAt }

  return {
    ok: true,
    items: applyItemDetails(light, detailed.details),
    queried: queriedLabelsOf(params.vocabulary),
    disabled: params.vocabulary.disabled,
    vocabulary: verifyVocabulary(params.vocabulary, swept.repoLabels),
    unavailable: [...swept.state.unavailable.values()],
    truncated: swept.truncated,
    rateLimit: detailed.rateLimit,
    viewer: swept.viewer,
    fetchedAt,
  }
}
