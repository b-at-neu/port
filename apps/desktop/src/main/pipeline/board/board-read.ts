// The board read: the issue half (through the tracker) and the pull-request half run in parallel,
// then merge back into one `PipelineFetch` in the order a single read produced.
import { fetchBoardPulls } from '@/main/github/pipeline'
import { mergeRateLimit } from '@/main/github/sweep'
import type { BoardReadContext } from '@/main/pipeline/context'
import type { BoardPullsFetch, GitHubRepoRef, PipelineFetch, PipelineItem, QueriedLabel } from '@/types/github'
import type { TrackedRef } from '@/types/pipeline-state'
import type { BoardIssuesFetch } from '@/main/github/tracker'
import { verifyVocabulary } from '@/utils/labels/vocabulary'
import type { LabelVocabulary, VerifiableVocabulary } from '@/utils/labels/vocabulary'

interface ReadBoardParams {
  readonly repo: GitHubRepoRef
  readonly vocabulary: LabelVocabulary
  /** What the repository's label list is checked against: the display vocabulary on an app-only repository. Absent means `vocabulary`. */
  readonly verify?: VerifiableVocabulary
  readonly integration: string
  /** The store's items: non-null makes them, not the swept labels, the set of items read. `null` is the label path. */
  readonly tracked?: readonly TrackedRef[] | null
}

interface MergeBoardParams {
  readonly issues: BoardIssuesFetch
  readonly pulls: BoardPullsFetch
  readonly tracked: readonly TrackedRef[] | null
  readonly vocabulary: LabelVocabulary
  readonly verify?: VerifiableVocabulary
  readonly fetchedAt: string
}

function queriedLabelsOf(vocabulary: LabelVocabulary): readonly QueriedLabel[] {
  return vocabulary.labels.map((label) => ({ key: label.key, name: label.name, source: label.source }))
}

/** The by-number reads of both halves in tracked-ref order, which is the order a single read produced. */
function byRefOrder(tracked: readonly TrackedRef[] | null, read: readonly PipelineItem[]): readonly PipelineItem[] {
  if (tracked === null) return read
  const position = new Map(tracked.map((ref, idx) => [`${ref.kind}:${String(ref.number)}`, idx]))
  const at = (item: PipelineItem): number => position.get(`${item.kind}:${String(item.number)}`) ?? 0
  return [...read].sort((a, b) => at(a) - at(b))
}

/** Fails closed: a half that failed is the whole board failing, never a partial board, so the cache keeps the last good fetch. */
export function mergeBoard(params: MergeBoardParams): PipelineFetch {
  const { issues, pulls, tracked, vocabulary, fetchedAt } = params
  if (!issues.ok) return { ok: false, kind: issues.kind, message: issues.message, fetchedAt }
  if (!pulls.ok) return { ok: false, kind: pulls.kind, message: pulls.message, fetchedAt }

  // Issue and pull-request numbers share one space, so a number names one ref.
  const closedNumbers = new Set([...issues.closed, ...pulls.closed])
  return {
    ok: true,
    items: [...issues.swept, ...pulls.swept, ...byRefOrder(tracked, [...issues.read, ...pulls.read])],
    closed: (tracked ?? []).map((ref) => ref.number).filter((number) => closedNumbers.has(number)),
    merged: pulls.merged,
    queried: queriedLabelsOf(vocabulary),
    disabled: vocabulary.disabled,
    vocabulary: verifyVocabulary(params.verify ?? vocabulary, issues.repoLabels),
    unavailable: [...issues.unavailable, ...pulls.unavailable],
    truncated: [...issues.truncated, ...pulls.truncated],
    rateLimit: mergeRateLimit(issues.rateLimit, pulls.rateLimit),
    viewer: issues.viewer,
    integrationChecks: pulls.integrationChecks,
    fetchedAt,
  }
}

/** Every pipeline item, the repository's real label list, and the rate-limit cost together. */
export async function readBoard(ctx: BoardReadContext, params: ReadBoardParams): Promise<PipelineFetch> {
  const fetchedAt = ctx.clock.now().toISOString()
  const tracked = params.tracked ?? null
  const [issues, pulls] = await Promise.all([
    ctx.tracker.readBoardIssues({ repo: params.repo, vocabulary: params.vocabulary, tracked: tracked?.filter((ref) => ref.kind === 'issue') ?? null }),
    fetchBoardPulls(ctx, { repo: params.repo, vocabulary: params.vocabulary, integration: params.integration, tracked: tracked?.filter((ref) => ref.kind === 'pull-request') ?? null }),
  ])
  return mergeBoard({ issues, pulls, tracked, vocabulary: params.vocabulary, verify: params.verify, fetchedAt })
}
