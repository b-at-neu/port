// No `gh` import here — the read comes from `./github`, the write from `./actions`.
import { classifyPreflight, buildClaimRequest } from '@/main/pipeline/claim/classify'
import type { ClaimApplyResponse, ClaimPreflight, ClaimPreflightResponse, PlanGateChoice } from '@/types/claim'
import type { ClaimPreflightFetch } from '@/types/github'
import { mirrorVocabularyOf } from '@/utils/labels/display'
import type { RepoId } from '@/utils/repos'
import type { ReadyEntry } from '@/types/actions'
import { storedLabels, UNSEEDED_MESSAGE } from '@/main/pipeline/state/labels'
import { writeState } from '@/main/pipeline/state/writer'
import { readyEntryOf, type OperatorContext } from '@/main/pipeline/context'
import { fetchClaimPreflight } from '@/main/github/tracker/items'

function resolveReadyEntry(ctx: OperatorContext, repoId: RepoId) {
  return readyEntryOf(ctx, 'claim', repoId, (message) => `claim requires the registry, which could not be listed: ${message}`)
}

// `null` passes straight through so `classifyPreflight` reports `not-found` itself; `'unseeded'` means the store holds no labels to read yet.
function toClaimPreflight(ctx: OperatorContext, fetch: Extract<ClaimPreflightFetch, { readonly ok: true }>, entry: ReadyEntry): ClaimPreflight | null | 'unseeded' {
  if (fetch.item === null) return null
  const labels = storedLabels(ctx, entry.id, fetch.item.kind, fetch.item.number, entry.config.vocabulary)
  if (labels === null) return 'unseeded'
  return { ...fetch.item, labels, viewer: fetch.viewer, readAt: fetch.fetchedAt }
}

export async function claimPreflight(ctx: OperatorContext, { repoId, number }: { readonly repoId: RepoId; readonly number: number }): Promise<ClaimPreflightResponse> {
  const entry = await resolveReadyEntry(ctx, repoId)
  const fetch = await fetchClaimPreflight(ctx, { repo: { owner: entry.config.owner, name: entry.config.name }, number })
  if (!fetch.ok) return { kind: 'failed', message: fetch.message }

  const preflight = toClaimPreflight(ctx, fetch, entry)
  if (preflight === 'unseeded') return { kind: 'failed', message: UNSEEDED_MESSAGE }
  const verdict = classifyPreflight({ item: preflight, vocabulary: entry.config.vocabulary })
  if (preflight === null) return { kind: 'unresolved' }
  return { kind: 'resolved', preflight, verdict }
}

interface ClaimApplyParams {
  readonly repoId: RepoId
  readonly number: number
  readonly planGate: PlanGateChoice
  /** `claimApply` refuses to write when a fresh read disagrees, so consent never applies to
   *  someone else. */
  readonly confirmedAssignees: readonly string[]
  readonly auditDir: string
}

function sameAssigneeSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const bSet = new Set(b)
  return a.every((login) => bSet.has(login))
}

// **Re-runs the preflight itself** rather than trusting anything the renderer held.
export async function claimApply(ctx: OperatorContext, params: ClaimApplyParams): Promise<ClaimApplyResponse> {
  const entry = await resolveReadyEntry(ctx, params.repoId)
  const fetch = await fetchClaimPreflight(ctx, { repo: { owner: entry.config.owner, name: entry.config.name }, number: params.number })
  if (!fetch.ok) return { kind: 'preflight-failed', message: fetch.message }

  const preflight = toClaimPreflight(ctx, fetch, entry)
  if (preflight === 'unseeded') return { kind: 'write', outcome: { kind: 'state-unsaved', message: UNSEEDED_MESSAGE } }
  const verdict = classifyPreflight({ item: preflight, vocabulary: entry.config.vocabulary })
  if (verdict.kind !== 'claimable') {
    return { kind: 'refused', verdict }
  }
  if (preflight === null) {
    // Unreachable defensive fallback — `classifyPreflight` only returns `claimable` for a non-null item.
    return { kind: 'refused', verdict: { kind: 'not-found' } }
  }

  if (!sameAssigneeSet(params.confirmedAssignees, preflight.assignees)) {
    return { kind: 'moved', confirmed: params.confirmedAssignees, current: preflight.assignees, readAt: preflight.readAt }
  }

  const request = buildClaimRequest({
    preflight,
    verdict,
    vocabulary: entry.config.vocabulary,
    mirror: mirrorVocabularyOf(entry.config),
    repoId: params.repoId,
    repo: entry.config.repo,
    planGate: params.planGate,
  })

  const outcome = await writeState(ctx, { request, repoRoot: entry.path, auditDir: params.auditDir })
  return { kind: 'write', outcome }
}
