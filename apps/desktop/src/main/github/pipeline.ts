// The pull-request half of the board read: a paged sweep whose first page also carries the
// integration branch's check history, tracked pull requests by number, then the per-PR details.
import type { GitHubReadContext } from '@/main/github/context'
import type { LabelVocabulary } from '@/utils/labels/vocabulary'
import type { BoardPullsFetch, GitHubRepoRef, PipelineItem } from '@/types/github'
import type { TrackedRef } from '@/types/pipeline-state'
import { applyItemDetails, mapPipelineItems, toIntegrationChecks } from '@/main/github/map'
import { buildPullDetailsQuery, buildPullSweepQuery, buildTrackedPullsQuery } from '@/main/github/query'
import { readDetailChunks, readTrackedChunks, selectTracked, sweepSurface } from '@/main/github/sweep'

interface FetchBoardPullsParams {
  readonly repo: GitHubRepoRef
  readonly vocabulary: LabelVocabulary
  /** `branches.integration`, whose recent check history rides on the sweep's first page. */
  readonly integration: string
  /** The store's pull-request refs: non-null makes them, not the swept labels, the set read. `null` is the label path. */
  readonly tracked: readonly TrackedRef[] | null
}

/** Every pull request the board shows and the integration branch's checks. Never filters the reply server-side, and no path returns an empty list for a read that did not succeed. */
export async function fetchBoardPulls(ctx: GitHubReadContext, params: FetchBoardPullsParams): Promise<BoardPullsFetch> {
  const github = ctx.githubHttp
  const { repo, vocabulary, integration, tracked } = params

  const sweep = await sweepSurface(github, repo, { alias: 'pullRequests', connection: vocabulary.labels.length > 0, build: (page) => buildPullSweepQuery(vocabulary, page, integration) })
  if (!sweep.ok) return sweep

  // A missing branch or an errored alias is `null` (unreadable), never an empty record, and never fails the board.
  const errored = (sweep.first.errors ?? []).some((error) => error.path?.[1] === 'integrationHistory')
  const integrationChecks = errored ? null : toIntegrationChecks(sweep.first.repository.integrationHistory)

  let swept: readonly PipelineItem[] = mapPipelineItems(sweep.nodes, 'pull-request', vocabulary, `${repo.owner}/${repo.name}`)
  let read: readonly PipelineItem[] = []
  let closed: readonly number[] = []
  let merged: readonly number[] = []
  let rateLimit = sweep.rateLimit
  if (tracked !== null) {
    const selected = selectTracked(swept, tracked)
    const byNumber = await readTrackedChunks(github, repo, vocabulary, 'pull-request', selected.missing, rateLimit, buildTrackedPullsQuery)
    if (!byNumber.ok) return byNumber
    swept = selected.kept
    read = byNumber.items
    closed = byNumber.closed
    merged = byNumber.merged
    rateLimit = byNumber.rateLimit
  }

  const detailed = await readDetailChunks(github, repo, rateLimit, {
    kind: 'pull-request',
    items: [...swept, ...read],
    perField: new Set(),
    build: (chunk) => buildPullDetailsQuery(chunk.map((item) => ({ number: item.number, rollup: item.matchedKeys.includes('approved') || item.matchedKeys.includes('readyForReview') }))),
  })
  if (!detailed.ok) return detailed

  const applied = applyItemDetails([...swept, ...read], detailed.details)
  return {
    ok: true,
    swept: applied.slice(0, swept.length),
    read: applied.slice(swept.length),
    closed,
    merged,
    unavailable: sweep.unavailable,
    truncated: sweep.truncated,
    rateLimit: detailed.rateLimit,
    integrationChecks,
  }
}
