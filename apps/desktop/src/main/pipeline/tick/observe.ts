import type { RefreshMemo, RerunMemo } from '@/types/tick'

// Pure: turns the report pieces planTick already computed into the four machine-observation write
// families. Every observation needs the viewer among the item's assignees.
import type { RepoId } from '@/utils/repos'
import type { Stage } from '@/utils/pipeline/ticket'
import { actsOn } from '@/main/pipeline/tick/holds'
import type { TrackedReconciled } from '@/main/pipeline/tick/holds'
import type { ReconciledItem } from '@/types/state'
import type { TickClaim, TickHeld, TickObservation } from '@/types/tick'
import { approvedReverify, capRefreshes, refreshDecision } from '@/utils/pipeline/gates'

import { actionsJobOf, historyDerivedChecks, rollupVerdict } from '@/utils/pipeline/checks'
import type { Disposition } from '@/utils/pipeline/checks'

interface ObservationsOfParams {
  readonly repoId: RepoId
  readonly items: readonly ReconciledItem[]
  readonly claims: readonly TickClaim[]
  readonly held: readonly TickHeld[]
  readonly viewer: string
  readonly refreshMemo: RefreshMemo
  /** The cockpit's own disposition map, passed directly to `rollupVerdict`. */
  readonly checkDispositions: Readonly<Record<string, Disposition>>
  /** Numbers `adopt.ts` already adopted this tick — their claim is settled, so it is never reset. */
  readonly adopted: ReadonlySet<number>
  /** `undefined` never re-runs a check, which fails toward the existing hold. */
  readonly rerunMemo?: RerunMemo
}

function eligible(item: Pick<ReconciledItem, 'assignees'>, viewer: string): boolean {
  return item.assignees.includes(viewer)
}

/** An approved pull request: the merge stage waiting on a person for the merge itself. */
function approvedOn(item: ReconciledItem): item is TrackedReconciled {
  return actsOn(item) && item.ticket.stage === 'merge' && item.ticket.status.kind === 'waiting-on-you' && item.ticket.status.gate === 'merge'
}

function livenessResetObservations(
  claims: readonly TickClaim[],
  itemByNumber: ReadonlyMap<number, ReconciledItem>,
  viewer: string,
  adopted: ReadonlySet<number>,
): readonly TickObservation[] {
  const out: TickObservation[] = []
  for (const claim of claims) {
    if (claim.class !== 'stalled-confirmed' || !claim.retryable || adopted.has(claim.number)) continue
    const item = itemByNumber.get(claim.number)
    if (item === undefined || !eligible(item, viewer)) continue
    out.push({ kind: 'liveness-reset', number: claim.number, itemKind: claim.kind, stage: claim.stage })
  }
  return out
}

function escalationObservations(held: readonly TickHeld[], itemByNumber: ReadonlyMap<number, ReconciledItem>, viewer: string): readonly TickObservation[] {
  const out: TickObservation[] = []
  for (const h of held) {
    if (h.reason !== 'cycle-cap' && h.reason !== 'zero-diff' && h.reason !== 'integration-red') continue
    const item = itemByNumber.get(h.number)
    if (item === undefined || !eligible(item, viewer)) continue
    if (h.reason === 'integration-red') {
      if (h.escalation?.kind === 'integration-red' && h.escalation.expired && item.headRefOid !== null) {
        out.push({ kind: 'integration-red', number: h.number, itemKind: h.kind, checks: h.escalation.checks, headRefOid: item.headRefOid })
      }
    } else if (h.reason === 'cycle-cap') {
      const count = h.escalation?.kind === 'cycle-cap' ? h.escalation.count : 0
      const cap = h.escalation?.kind === 'cycle-cap' ? h.escalation.cap : 0
      out.push({ kind: 'cycle-cap', number: h.number, itemKind: h.kind, count, cap })
    } else if (item.headRefOid !== null) {
      out.push({ kind: 'zero-diff', number: h.number, itemKind: h.kind, count: item.reviewCycleCount ?? 0, headRefOid: item.headRefOid })
    }
  }
  return out
}

/** One failed-jobs re-run per head for a review held on red checks — only for checks that ran in Actions. */
function rerunObservations(held: readonly TickHeld[], itemByNumber: ReadonlyMap<number, ReconciledItem>, viewer: string, repoId: RepoId, rerunMemo: RerunMemo | undefined): readonly TickObservation[] {
  const out: TickObservation[] = []
  if (rerunMemo === undefined) return out
  for (const h of held) {
    if (h.reason !== 'check-hold' || h.escalation?.kind !== 'check-hold' || h.escalation.state !== 'red') continue
    const item = itemByNumber.get(h.number)
    if (item === undefined || !eligible(item, viewer) || item.headRefOid === null) continue
    if (rerunMemo.get(repoId, h.number) === item.headRefOid) continue
    const runs: { check: string; runId: string }[] = []
    for (const check of h.escalation.checks) {
      const url = (item.checkRollup ?? []).find((c) => c.name === check)?.url
      const job = actionsJobOf(url)
      if (job !== null && !runs.some((r) => r.runId === job.runId)) runs.push({ check, runId: job.runId })
    }
    if (runs.length > 0) out.push({ kind: 'rerun-checks', number: h.number, itemKind: h.kind, runs, headRefOid: item.headRefOid })
  }
  return out
}

interface RefreshCandidate {
  readonly number: number
  readonly itemKind: ReconciledItem['kind']
  readonly from: Stage
  readonly headRefOid: string
  readonly cause: 'conflict' | 'integration-green'
}

function refreshCandidatesOf(held: readonly TickHeld[], items: readonly ReconciledItem[], viewer: string, dispositions: Readonly<Record<string, Disposition>>): readonly RefreshCandidate[] {
  const candidates: RefreshCandidate[] = []

  for (const h of held) {
    if (h.reason !== 'conflicting' && h.reason !== 'integration-green') continue
    const item = items.find((i) => i.number === h.number)
    if (item === undefined || !eligible(item, viewer) || item.headRefOid === null) continue
    candidates.push({ number: h.number, itemKind: h.kind, from: 'review', headRefOid: item.headRefOid, cause: h.reason === 'conflicting' ? 'conflict' : 'integration-green' })
  }

  for (const item of items) {
    if (!approvedOn(item) || !eligible(item, viewer)) continue
    if (item.headRefOid === null) continue
    const verdict = rollupVerdict(item.checkRollup, dispositions)
    const reverify = approvedReverify({ verdict, mergeable: item.mergeable })
    if (reverify.action !== 'refresh-in-place') continue
    candidates.push({ number: item.number, itemKind: item.kind, from: 'merge', headRefOid: item.headRefOid, cause: 'conflict' })
  }

  return candidates
}

const MAX_REFRESHES_PER_PASS = 5

function refreshObservations(held: readonly TickHeld[], items: readonly ReconciledItem[], viewer: string, repoId: RepoId, refreshMemo: RefreshMemo, dispositions: Readonly<Record<string, Disposition>>): readonly TickObservation[] {
  const out: TickObservation[] = []
  const candidates = refreshCandidatesOf(held, items, viewer, dispositions)
  const { toRefresh, deferred } = capRefreshes(candidates, MAX_REFRESHES_PER_PASS)

  for (const candidate of deferred) {
    out.push({ kind: 'refresh-deferred', number: candidate.number, itemKind: candidate.itemKind })
  }

  for (const candidate of toRefresh) {
    const decision = refreshDecision(refreshMemo.get(repoId, candidate.number), candidate.headRefOid)
    if (decision.action === 'refresh') {
      out.push({ kind: 'refresh', number: candidate.number, itemKind: candidate.itemKind, from: candidate.from, headRefOid: candidate.headRefOid, count: decision.count, cause: candidate.cause })
    } else {
      out.push({
        kind: 'refresh-stuck',
        number: candidate.number,
        itemKind: candidate.itemKind,
        from: candidate.from,
        reason: decision.reason,
        sha: candidate.headRefOid,
        count: decision.count,
      })
    }
  }

  return out
}

function withdrawApprovalObservations(items: readonly ReconciledItem[], viewer: string, dispositions: Readonly<Record<string, Disposition>>): readonly TickObservation[] {
  const out: TickObservation[] = []
  for (const item of items) {
    if (!approvedOn(item) || !eligible(item, viewer)) continue
    if (item.headRefOid === null) continue
    const verdict = rollupVerdict(item.checkRollup, dispositions)
    const reverify = approvedReverify({ verdict, mergeable: item.mergeable, historyDerived: historyDerivedChecks(dispositions) })
    if (reverify.action !== 'withdraw' && reverify.action !== 'escalate') continue
    // Enriches each red check with its own url, looked up from the item's own rollup by name.
    const red = reverify.red.map((r) => ({ ...r, url: (item.checkRollup ?? []).find((c) => c.name === r.name)?.url ?? null }))
    out.push({ kind: 'withdraw-approval', number: item.number, itemKind: item.kind, route: reverify.action === 'escalate' ? 'human' : 'revise', red, headRefOid: item.headRefOid })
  }
  return out
}

/** Every pull request reading `MERGEABLE` clears its refresh memo, so a later conflict refreshes
 *  again rather than reading as a same-SHA repeat of a resolved one. */
function clearResolvedRefreshMemos(items: readonly ReconciledItem[], repoId: RepoId, refreshMemo: RefreshMemo): void {
  for (const item of items) {
    if (item.kind !== 'pull-request' || item.mergeable !== 'MERGEABLE') continue
    if (refreshMemo.get(repoId, item.number) !== undefined) refreshMemo.clear(repoId, item.number)
  }
}

export function observationsOf(params: ObservationsOfParams): readonly TickObservation[] {
  const { repoId, items, claims, held, viewer, refreshMemo, checkDispositions, adopted, rerunMemo } = params
  const itemByNumber = new Map(items.map((item) => [item.number, item] as const))

  clearResolvedRefreshMemos(items, repoId, refreshMemo)

  return [
    ...livenessResetObservations(claims, itemByNumber, viewer, adopted),
    ...rerunObservations(held, itemByNumber, viewer, repoId, rerunMemo),
    ...escalationObservations(held, itemByNumber, viewer),
    ...refreshObservations(held, items, viewer, repoId, refreshMemo, checkDispositions),
    ...withdrawApprovalObservations(items, viewer, checkDispositions),
  ]
}
