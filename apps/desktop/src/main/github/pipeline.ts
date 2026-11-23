// The pull-request half of the board read: a paged one-connection sweep (page one also reads the integration branch's
// checks), then a per-number detail read. PRs are GitHub on every vendor, so this stays in the adapter.
import type { GitHubTransport } from '@/types/platform'
import { githubHttp } from '@/main/platform/github-http'
import type { LabelVocabulary } from '@/utils/labels/vocabulary'
import type { AliasInfo, BoardPullRequestsRead, GitHubRepoRef, IntegrationChecks, ItemDetail, PipelineItem, RateLimitInfo, ReadFailure, SweepAlias, SweepCursor, TruncatedSet, UnavailableAlias } from '@/types/github'
import type { TrackedRef } from '@/types/pipeline-state'
import { collectUnavailable } from '@/main/github/envelope'
import { applyItemDetails, keepTracked, mapPipelineItems, mapTrackedItem, toIntegrationChecks } from '@/main/github/map'
import { buildPullRequestDetailsQuery, buildPullRequestSweepQuery, buildTrackedPullRequestsQuery } from '@/main/github/query'
import { DETAIL_CHUNK_SIZE, MAX_SWEEP_PAGES, NO_RATE_LIMIT, addRateLimit, asRecord, graphql } from '@/main/github/reply'

const ALIAS_INDEX: ReadonlyMap<SweepAlias, AliasInfo> = new Map<SweepAlias, AliasInfo>([['pullRequests', { surface: 'pull-request' }]])

interface SweepResult {
  readonly nodes: readonly unknown[]
  readonly rateLimit: RateLimitInfo
  readonly integrationChecks: IntegrationChecks | null
  readonly unavailable: readonly UnavailableAlias[]
  readonly truncated: readonly TruncatedSet[]
}

async function sweep(github: GitHubTransport, repo: GitHubRepoRef, vocabulary: LabelVocabulary, integration: string): Promise<SweepResult | ReadFailure> {
  const nodes: unknown[] = []
  let total = 0
  let unavailable: readonly UnavailableAlias[] = []
  let rateLimit = NO_RATE_LIMIT
  let integrationChecks: IntegrationChecks | null = null
  let truncated: readonly TruncatedSet[] = []
  let after: SweepCursor = null

  for (let fetched = 1; ; fetched++) {
    const reply = await graphql(github, repo, buildPullRequestSweepQuery(vocabulary, after, integration))
    if (!reply.ok) return reply
    rateLimit = addRateLimit(rateLimit, reply.data.rateLimit)
    if (fetched === 1) {
      // A missing branch, an errored alias or a missing alias is `null` (unreadable), never an empty record, and never fails the board.
      const errored = (reply.errors ?? []).some((error) => error.path?.[1] === 'integrationHistory')
      integrationChecks = errored ? null : toIntegrationChecks(reply.repository.integrationHistory)
    }
    // With no enabled label the connection is not asked at all, so page one carries only the integration history.
    if (vocabulary.labels.length === 0) break

    const named = collectUnavailable(reply.errors, ALIAS_INDEX)
    const connection = asRecord(reply.repository.pullRequests)
    const page = connection?.nodes
    if (named.length > 0 || connection === undefined || !Array.isArray(page)) {
      unavailable = named.length > 0 ? named : [{ alias: 'pullRequests', surface: 'pull-request' }]
      break
    }
    for (const raw of page) nodes.push(raw)
    if (typeof connection.totalCount === 'number') total = connection.totalCount
    const pageInfo = asRecord(connection.pageInfo)
    const next = pageInfo?.hasNextPage === true && typeof pageInfo.endCursor === 'string' ? pageInfo.endCursor : null
    if (next === null) break
    if (fetched >= MAX_SWEEP_PAGES) {
      truncated = [{ alias: 'pullRequests', surface: 'pull-request', totalCount: total, received: nodes.length }]
      break
    }
    after = next
  }

  return { nodes, rateLimit, integrationChecks, unavailable, truncated }
}

interface DetailsResult {
  readonly details: readonly ItemDetail[]
  readonly rateLimit: RateLimitInfo
}

/** Any detail alias that errors or comes back null fails the whole read: a missing review list would
 *  read as zero cycles, and a revise dispatch could go past the cap. */
async function readDetails(github: GitHubTransport, repo: GitHubRepoRef, items: readonly PipelineItem[], rateLimit: RateLimitInfo): Promise<DetailsResult | ReadFailure> {
  const refs = items.map((item) => ({ number: item.number, rollup: item.matchedKeys.includes('approved') || item.matchedKeys.includes('readyForReview') }))
  const details: ItemDetail[] = []
  let total = rateLimit

  for (let start = 0; start < refs.length; start += DETAIL_CHUNK_SIZE) {
    const { document, aliases } = buildPullRequestDetailsQuery(refs.slice(start, start + DETAIL_CHUNK_SIZE))
    const reply = await graphql(github, repo, document)
    if (!reply.ok) return reply
    total = addRateLimit(total, reply.data.rateLimit)
    const errors = reply.errors ?? []
    for (const alias of aliases) {
      const node = reply.repository[alias.alias]
      if (errors.some((error) => error.path?.[1] === alias.alias) || asRecord(node) === undefined) {
        return { ok: false, kind: 'no-data', message: `the detail read for pull-request #${alias.number} came back empty` }
      }
      details.push({ kind: 'pull-request', number: alias.number, node, erroredFields: [] })
    }
  }

  return { details, rateLimit: total }
}

interface TrackedResult {
  readonly items: readonly PipelineItem[]
  readonly closed: readonly number[]
  readonly merged: readonly number[]
  readonly rateLimit: RateLimitInfo
}

/** An alias GitHub reports as not found is gone for good, so it is closed; any other error or a malformed node fails the whole read, the same rule as the detail read. A closed pull request with `mergedAt` is also merged. */
async function readTracked(github: GitHubTransport, repo: GitHubRepoRef, vocabulary: LabelVocabulary, missing: readonly TrackedRef[], rateLimit: RateLimitInfo): Promise<TrackedResult | ReadFailure> {
  const items: PipelineItem[] = []
  const closed: number[] = []
  const merged: number[] = []
  let total = rateLimit
  for (let start = 0; start < missing.length; start += DETAIL_CHUNK_SIZE) {
    const chunk = missing.slice(start, start + DETAIL_CHUNK_SIZE)
    const { document, aliases } = buildTrackedPullRequestsQuery(chunk)
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
      const item = node === undefined || own.length > 0 ? undefined : mapTrackedItem(node, 'pull-request', vocabulary, `${repo.owner}/${repo.name}`, chunk[idx]?.keys ?? [])
      if (item === undefined) return { ok: false, kind: 'no-data', message: `the read of tracked pull-request #${alias.number} came back empty` }
      if (item.state === 'OPEN') {
        items.push(item)
        continue
      }
      closed.push(alias.number)
      if (item.mergedAt !== null) merged.push(alias.number)
    }
  }
  return { items, closed, merged, rateLimit: total }
}

interface ReadBoardPullRequestsParams {
  readonly repo: GitHubRepoRef
  readonly vocabulary: LabelVocabulary
  /** The store's pull-request refs: non-null makes them, not the swept labels, the set of pull requests read. `null` is the label path. */
  readonly tracked: readonly TrackedRef[] | null
  /** `branches.integration`, whose recent check history the integration-red gate compares against. */
  readonly integration: string
  readonly github?: GitHubTransport
}

/** Every pull request the board shows, detail-read, with the integration branch's checks. Never filters the reply
 *  server-side, and no path returns an empty list for a read that did not succeed. */
export async function readBoardPullRequests(params: ReadBoardPullRequestsParams): Promise<BoardPullRequestsRead> {
  const github = params.github ?? githubHttp
  const repo = `${params.repo.owner}/${params.repo.name}`

  const swept = await sweep(github, params.repo, params.vocabulary, params.integration)
  if ('ok' in swept) return swept

  const sweptItems = mapPipelineItems(swept.nodes, 'pull-request', params.vocabulary, repo)
  let kept = sweptItems
  let read: TrackedResult = { items: [], closed: [], merged: [], rateLimit: swept.rateLimit }
  if (params.tracked !== null) {
    const split = keepTracked(sweptItems, params.tracked)
    kept = split.kept
    const tracked = await readTracked(github, params.repo, params.vocabulary, split.missing, swept.rateLimit)
    if ('ok' in tracked) return tracked
    read = tracked
  }

  const detailed = await readDetails(github, params.repo, [...kept, ...read.items], read.rateLimit)
  if ('ok' in detailed) return detailed
  const items = applyItemDetails([...kept, ...read.items], detailed.details)

  return {
    ok: true,
    swept: items.slice(0, kept.length),
    tracked: items.slice(kept.length),
    closed: read.closed,
    merged: read.merged,
    integrationChecks: swept.integrationChecks,
    unavailable: swept.unavailable,
    truncated: swept.truncated,
    rateLimit: detailed.rateLimit,
  }
}
