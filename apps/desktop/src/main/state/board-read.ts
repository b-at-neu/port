// The board read: the tracker's issue half and the GitHub adapter's pull-request half run in parallel, then merge into one `PipelineFetch`.
import { readBoardPullRequests } from '@/main/github/pipeline'
import type { GitHubTransport } from '@/types/platform'
import { verifyVocabulary } from '@/utils/labels/vocabulary'
import type { LabelVocabulary, VerifiableVocabulary } from '@/utils/labels/vocabulary'
import type { PipelineFetch, PipelineItem, QueriedLabel, RateLimitInfo } from '@/types/github'
import type { TrackedRef } from '@/types/pipeline-state'
import type { Tracker } from '@/types/tracker'

interface ReadBoardParams {
  readonly tracker: Tracker
  readonly repo: { readonly owner: string; readonly name: string }
  readonly vocabulary: LabelVocabulary
  /** What the repository's label list is checked against: the display vocabulary on an app-only repository. Absent means `vocabulary`. */
  readonly verify?: VerifiableVocabulary
  readonly integration: string
  /** The store's items: non-null makes them, not the swept labels, the set of items read. `null` is the label path. */
  readonly tracked?: readonly TrackedRef[] | null
  readonly github?: GitHubTransport
  readonly now?: () => Date
}

function queriedLabelsOf(vocabulary: LabelVocabulary): readonly QueriedLabel[] {
  return vocabulary.labels.map((label) => ({ key: label.key, name: label.name, source: label.source }))
}

/** `cost` sums both halves; the rest comes from the half with the lower `remaining`, an unread half (`limit` 0) never winning. */
function mergeRateLimit(issues: RateLimitInfo, pulls: RateLimitInfo): RateLimitInfo {
  const cost = issues.cost + pulls.cost
  if (issues.limit === 0) return { ...pulls, cost }
  if (pulls.limit === 0) return { ...issues, cost }
  return { ...(pulls.remaining < issues.remaining ? pulls : issues), cost }
}

/** Every pipeline item, the repository's real label list, and the rate-limit cost together. Either half failing fails the read:
 *  a rate limit wins so the scheduler still defers to `resetAt`, and a failed half is never merged as an empty one. */
export async function readBoard(params: ReadBoardParams): Promise<PipelineFetch> {
  const now = params.now ?? (() => new Date())
  const fetchedAt = now().toISOString()
  const refs = params.tracked ?? null

  const [issues, pulls] = await Promise.all([
    params.tracker.readBoardIssues({ repo: params.repo, vocabulary: params.vocabulary, tracked: refs === null ? null : refs.filter((ref) => ref.kind === 'issue') }),
    readBoardPullRequests({ repo: params.repo, vocabulary: params.vocabulary, tracked: refs === null ? null : refs.filter((ref) => ref.kind === 'pull-request'), integration: params.integration, github: params.github }),
  ])
  if (!issues.ok || !pulls.ok) {
    const failures = [issues, pulls].flatMap((read) => (read.ok ? [] : [read]))
    const failure = failures.find((read) => read.kind === 'rate-limited') ?? failures[0]
    if (failure === undefined) return { ok: false, kind: 'no-data', message: 'internal: a failed read without a failure', fetchedAt }
    return { ok: false, kind: failure.kind, message: failure.message, fetchedAt }
  }

  const order = new Map((refs ?? []).map((ref, index) => [ref.number, index]))
  const position = (number: number): number => order.get(number) ?? order.size
  const trackedItems: readonly PipelineItem[] = [...issues.tracked, ...pulls.tracked].sort((a, b) => position(a.number) - position(b.number))
  const closed = [...issues.closed, ...pulls.closed].sort((a, b) => position(a) - position(b))

  return {
    ok: true,
    items: [...issues.swept, ...pulls.swept, ...trackedItems],
    closed,
    merged: pulls.merged,
    queried: queriedLabelsOf(params.vocabulary),
    disabled: params.vocabulary.disabled,
    vocabulary: verifyVocabulary(params.verify ?? params.vocabulary, issues.repoLabels),
    unavailable: [...issues.unavailable, ...pulls.unavailable],
    truncated: [...issues.truncated, ...pulls.truncated],
    rateLimit: mergeRateLimit(issues.rateLimit, pulls.rateLimit),
    viewer: issues.viewer,
    integrationChecks: pulls.integrationChecks,
    fetchedAt,
  }
}
