// The issue half of the board read: a paged one-connection sweep for the light fields, then a per-number detail
// read for the heavy ones. Cost stays flat in the number of enabled labels.
import type { GitHubTransport } from '@/types/platform'
import { githubHttp } from '@/main/platform/github-http'
import type { LabelKey, LabelVocabulary, RepoLabels } from '@/utils/labels/vocabulary'
import type { AliasInfo, GitHubRepoRef, GraphQLErrorEntry, ItemDetail, PipelineItem, RateLimitInfo, SweepAlias, SweepCursor, TruncatedSet, UnavailableAlias } from '@/types/github'
import type { TrackedRef } from '@/types/pipeline-state'
import type { BoardIssuesRead } from '@/types/tracker'
import { collectUnavailable } from '@/main/github/envelope'
import { applyItemDetails, keepTracked, mapPipelineItems, mapTrackedItem } from '@/main/github/map'
import { DETAIL_CHUNK_SIZE, MAX_SWEEP_PAGES, NO_RATE_LIMIT, addRateLimit, asRecord, graphql } from '@/main/github/reply'
import type { Failure } from '@/main/github/reply'
import { buildIssueDetailsQuery, buildIssueSweepQuery, buildTrackedIssuesQuery } from '@/main/github/tracker/query'

const ALIAS_INDEX: ReadonlyMap<SweepAlias, AliasInfo> = new Map<SweepAlias, AliasInfo>([['issues', { surface: 'issue' }]])

/** `null`, never a guess, when the alias is absent, malformed, or named in `errors[].path`.
 *  Unlike `readClaimPreflight`'s `viewerLogin`, this never fails the whole read. */
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

interface SweepResult {
  readonly nodes: readonly unknown[]
  readonly rateLimit: RateLimitInfo
  readonly viewer: string | null
  readonly repoLabels: RepoLabels
  readonly unavailable: readonly UnavailableAlias[]
  readonly truncated: readonly TruncatedSet[]
}

async function sweep(github: GitHubTransport, repo: GitHubRepoRef, vocabulary: LabelVocabulary): Promise<SweepResult | Failure> {
  const nodes: unknown[] = []
  let total = 0
  let unavailable: readonly UnavailableAlias[] = []
  let rateLimit = NO_RATE_LIMIT
  let viewer: string | null = null
  let repoLabels: RepoLabels = { ok: false, reason: 'repoLabels alias missing from the response' }
  let truncated: readonly TruncatedSet[] = []
  let after: SweepCursor = null

  for (let fetched = 1; ; fetched++) {
    const reply = await graphql(github, repo, buildIssueSweepQuery(vocabulary, after))
    if (!reply.ok) return reply
    rateLimit = addRateLimit(rateLimit, reply.data.rateLimit)
    if (fetched === 1) {
      viewer = toViewer(reply.data.viewer, reply.errors)
      repoLabels = toRepoLabels(reply.repository.repoLabels)
    }
    // With no enabled label the connection is not asked at all, so page one carries only the extras.
    if (vocabulary.labels.length === 0) break

    const named = collectUnavailable(reply.errors, ALIAS_INDEX)
    const connection = asRecord(reply.repository.issues)
    const page = connection?.nodes
    if (named.length > 0 || connection === undefined || !Array.isArray(page)) {
      unavailable = named.length > 0 ? named : [{ alias: 'issues', surface: 'issue' }]
      break
    }
    nodes.push(...page)
    if (typeof connection.totalCount === 'number') total = connection.totalCount
    const pageInfo = asRecord(connection.pageInfo)
    const next = pageInfo?.hasNextPage === true && typeof pageInfo.endCursor === 'string' ? pageInfo.endCursor : null
    if (next === null) break
    if (fetched >= MAX_SWEEP_PAGES) {
      truncated = [{ alias: 'issues', surface: 'issue', totalCount: total, received: nodes.length }]
      break
    }
    after = next
  }

  return { nodes, rateLimit, viewer, repoLabels, unavailable, truncated }
}

// Only an issue alias's own blockedBy/comments/closedByPullRequestsReferences error is per-field: it costs a tag, never the board.
const PER_FIELD_ERRORS: ReadonlySet<unknown> = new Set(['blockedBy', 'comments', 'closedByPullRequestsReferences'])

/** The issue stages whose closing pull requests are read: one that already opened its pull request can be adopted instead of re-dispatched. */
const CLOSING_READ_KEYS: readonly LabelKey[] = ['planApproved', 'inProgress', 'blocked', 'prOpened']

interface DetailsResult {
  readonly details: readonly ItemDetail[]
  readonly rateLimit: RateLimitInfo
}

/** Any other detail alias that errors or comes back null fails the whole read: a missing blocker list would
 *  read as no blockers. */
async function readDetails(github: GitHubTransport, repo: GitHubRepoRef, items: readonly PipelineItem[], rateLimit: RateLimitInfo): Promise<DetailsResult | Failure> {
  const refs = items.map((item) => ({
    number: item.number,
    blockerComments: item.matchedKeys.includes('blocked'),
    closingPullRequests: CLOSING_READ_KEYS.some((key) => item.matchedKeys.includes(key)),
  }))
  const details: ItemDetail[] = []
  let total = rateLimit

  for (let start = 0; start < refs.length; start += DETAIL_CHUNK_SIZE) {
    const { document, aliases } = buildIssueDetailsQuery(refs.slice(start, start + DETAIL_CHUNK_SIZE))
    const reply = await graphql(github, repo, document)
    if (!reply.ok) return reply
    total = addRateLimit(total, reply.data.rateLimit)
    const errors = reply.errors ?? []
    for (const alias of aliases) {
      const node = reply.repository[alias.alias]
      const own = errors.filter((error) => error.path?.[1] === alias.alias)
      const perField = own.filter((error) => PER_FIELD_ERRORS.has(error.path?.[2]))
      if (own.length > perField.length || asRecord(node) === undefined) {
        return { ok: false, kind: 'no-data', message: `the detail read for issue #${alias.number} came back empty` }
      }
      const erroredFields = perField.map((error) => String(error.path?.[2]))
      details.push({ kind: 'issue', number: alias.number, node, erroredFields })
    }
  }

  return { details, rateLimit: total }
}

interface TrackedResult {
  readonly items: readonly PipelineItem[]
  readonly closed: readonly number[]
  readonly rateLimit: RateLimitInfo
}

/** An alias GitHub reports as not found is gone for good, so it is closed; any other error or a malformed node fails the whole read, the same rule as the detail read. */
async function readTracked(github: GitHubTransport, repo: GitHubRepoRef, vocabulary: LabelVocabulary, missing: readonly TrackedRef[], rateLimit: RateLimitInfo): Promise<TrackedResult | Failure> {
  const items: PipelineItem[] = []
  const closed: number[] = []
  let total = rateLimit
  for (let start = 0; start < missing.length; start += DETAIL_CHUNK_SIZE) {
    const chunk = missing.slice(start, start + DETAIL_CHUNK_SIZE)
    const { document, aliases } = buildTrackedIssuesQuery(chunk)
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
      const item = node === undefined || own.length > 0 ? undefined : mapTrackedItem(node, 'issue', vocabulary, `${repo.owner}/${repo.name}`, chunk[idx]?.keys ?? [])
      if (item === undefined) return { ok: false, kind: 'no-data', message: `the read of tracked issue #${alias.number} came back empty` }
      if (item.state === 'OPEN') {
        items.push(item)
        continue
      }
      closed.push(alias.number)
    }
  }
  return { items, closed, rateLimit: total }
}

/** Every issue the board shows, detail-read, with the repository's real label list. Never filters the reply
 *  server-side, and no path returns an empty list for a read that did not succeed. */
export async function readBoardIssues(params: { readonly repo: GitHubRepoRef; readonly vocabulary: LabelVocabulary; readonly tracked: readonly TrackedRef[] | null; readonly github?: GitHubTransport }): Promise<BoardIssuesRead> {
  const github = params.github ?? githubHttp
  const repo = `${params.repo.owner}/${params.repo.name}`

  const swept = await sweep(github, params.repo, params.vocabulary)
  if ('ok' in swept) return swept

  const sweptItems = mapPipelineItems(swept.nodes, 'issue', params.vocabulary, repo)
  let kept = sweptItems
  let read: TrackedResult = { items: [], closed: [], rateLimit: swept.rateLimit }
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
    viewer: swept.viewer,
    repoLabels: swept.repoLabels,
    unavailable: swept.unavailable,
    truncated: swept.truncated,
    rateLimit: detailed.rateLimit,
  }
}
