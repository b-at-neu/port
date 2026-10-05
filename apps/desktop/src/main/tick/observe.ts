// Pure: turns the report pieces `planTick` already computed (`claims`,
// `held`) plus the reconciled items themselves into the four
// machine-observation write families #292 ports from the cockpit's own
// cadence (`main/dispatch/dispatcher.ts` is the only writer — this module
// only decides). Every observation needs the viewer among the item's
// assignees and a non-contradictory label set (at most one role-bearing key
// outside `REFRESH_PAIR`, never both refresh keys at once) — the same State
// invariant `docs/PIPELINE.md` → "Label lifecycle" already states for every
// other write. `refreshMemo` is the one stateful collaborator this module
// reads *and* writes, the same way `plan.ts`'s `claimsOf` already writes
// `ledger.advance(` — a decision layer that still owns its own process-memory
// bookkeeping, never reaching real I/O.
import type { LabelKey } from '../../shared/labels/vocabulary'
import type { RepoId } from '../../shared/repos'
import type { ReconciledItem } from '../../shared/state/types'
import type { TickClaim, TickHeld, TickObservation } from '../../shared/tick/types'
import { approvedReverify, capRefreshes, refreshDecision } from '../../../../../scripts/port-tick/gates'
import type { RefreshMemo } from './ledger'
import { rollupVerdict } from '../../../../../scripts/port-tick/checks'
import type { Disposition } from '../../../../../scripts/port-tick/checks'
import { REFRESH_PAIR } from './routing'

export interface ObservationsOfParams {
  readonly repoId: RepoId
  readonly items: readonly ReconciledItem[]
  readonly claims: readonly TickClaim[]
  readonly held: readonly TickHeld[]
  readonly viewer: string
  readonly refreshMemo: RefreshMemo
  /** #300: the cockpit's own disposition map, straight off
   *  `ResolvedRepoConfig.checkDispositions` — passed directly to
   *  `rollupVerdict`, never folded a second way here. */
  readonly checkDispositions: Readonly<Record<string, Disposition>>
}

/** At most one role-bearing key outside `REFRESH_PAIR`, or both at once —
 *  the same contradiction test `scripts/port-tick/reconcile.ts`'s own
 *  `isContradiction` applies, over this app's already-resolved `stages`
 *  rather than raw label names. */
function isContradictory(item: Pick<ReconciledItem, 'stages'>): boolean {
  const roleBearing = item.stages.filter((s) => s.role !== 'marker').map((s) => s.key)
  const nonRefresh = roleBearing.filter((k) => !REFRESH_PAIR.includes(k))
  const bothRefresh = REFRESH_PAIR.every((k) => roleBearing.includes(k))
  return nonRefresh.length >= 2 || bothRefresh
}

function eligible(item: Pick<ReconciledItem, 'assignees' | 'stages'>, viewer: string): boolean {
  return item.assignees.includes(viewer) && !isContradictory(item)
}

function carries(item: ReconciledItem, key: LabelKey): boolean {
  return item.stages.some((s) => s.key === key)
}

function livenessResetObservations(claims: readonly TickClaim[], itemByNumber: ReadonlyMap<number, ReconciledItem>, viewer: string): readonly TickObservation[] {
  const out: TickObservation[] = []
  for (const claim of claims) {
    if (claim.class !== 'stalled-confirmed' || claim.retryKey === null) continue
    const item = itemByNumber.get(claim.number)
    if (item === undefined || !eligible(item, viewer)) continue
    out.push({ kind: 'liveness-reset', number: claim.number, itemKind: claim.kind, inFlight: claim.inFlight, retryKey: claim.retryKey })
  }
  return out
}

function escalationObservations(held: readonly TickHeld[], itemByNumber: ReadonlyMap<number, ReconciledItem>, viewer: string): readonly TickObservation[] {
  const out: TickObservation[] = []
  for (const h of held) {
    if (h.reason !== 'cycle-cap' && h.reason !== 'zero-diff') continue
    const item = itemByNumber.get(h.number)
    if (item === undefined || !eligible(item, viewer)) continue
    if (h.reason === 'cycle-cap') {
      const count = h.escalation?.kind === 'cycle-cap' ? h.escalation.count : 0
      const cap = h.escalation?.kind === 'cycle-cap' ? h.escalation.cap : 0
      out.push({ kind: 'cycle-cap', number: h.number, itemKind: h.kind, count, cap })
    } else if (item.headRefOid !== null) {
      out.push({ kind: 'zero-diff', number: h.number, itemKind: h.kind, count: item.reviewCycleCount ?? 0, headRefOid: item.headRefOid })
    }
  }
  return out
}

interface RefreshCandidate {
  readonly number: number
  readonly itemKind: ReconciledItem['kind']
  readonly sourceLabel: 'readyForReview' | 'approved'
  readonly headRefOid: string
}

function refreshCandidatesOf(held: readonly TickHeld[], items: readonly ReconciledItem[], viewer: string, dispositions: Readonly<Record<string, Disposition>>): readonly RefreshCandidate[] {
  const candidates: RefreshCandidate[] = []

  for (const h of held) {
    if (h.reason !== 'conflicting') continue
    const item = items.find((i) => i.number === h.number)
    if (item === undefined || !eligible(item, viewer) || item.headRefOid === null) continue
    candidates.push({ number: h.number, itemKind: h.kind, sourceLabel: 'readyForReview', headRefOid: item.headRefOid })
  }

  for (const item of items) {
    if (!carries(item, 'approved') || !eligible(item, viewer)) continue
    if (carries(item, 'refreshBranch') || carries(item, 'refreshing')) continue
    if (item.headRefOid === null) continue
    const verdict = rollupVerdict(item.checkRollup, dispositions)
    const reverify = approvedReverify({ verdict, mergeable: item.mergeable })
    if (reverify.action !== 'refresh-in-place') continue
    candidates.push({ number: item.number, itemKind: item.kind, sourceLabel: 'approved', headRefOid: item.headRefOid })
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
      out.push({ kind: 'refresh', number: candidate.number, itemKind: candidate.itemKind, sourceLabel: candidate.sourceLabel, headRefOid: candidate.headRefOid, count: decision.count })
    } else {
      out.push({
        kind: 'refresh-stuck',
        number: candidate.number,
        itemKind: candidate.itemKind,
        sourceLabel: candidate.sourceLabel,
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
    if (!carries(item, 'approved') || !eligible(item, viewer)) continue
    if (carries(item, 'refreshBranch') || carries(item, 'refreshing')) continue
    if (item.headRefOid === null) continue
    const verdict = rollupVerdict(item.checkRollup, dispositions)
    const reverify = approvedReverify({ verdict, mergeable: item.mergeable })
    if (reverify.action !== 'withdraw') continue
    // Enriches each red check with its own `url` (`scripts/port-tick/checks.ts`'s
    // `rollupVerdict` stays a verbatim port of the cockpit's own shape, which
    // carries neither) — looked up from the item's own rollup by name, so
    // the `## Approval withdrawn` comment can carry the link FORMATS.md's
    // own template names.
    const red = reverify.red.map((r) => ({ ...r, url: (item.checkRollup ?? []).find((c) => c.name === r.name)?.url ?? null }))
    out.push({ kind: 'withdraw-approval', number: item.number, itemKind: item.kind, red, headRefOid: item.headRefOid })
  }
  return out
}

/** Every pull request reading `MERGEABLE` clears its refresh memo (TICK-
 *  PROSE.md's own "Refresh sweep" rule), since a refresh consumes no review
 *  cycle and a cleared memo is what lets a later conflict refresh again
 *  rather than reading as a same-SHA repeat of a resolved one. */
function clearResolvedRefreshMemos(items: readonly ReconciledItem[], repoId: RepoId, refreshMemo: RefreshMemo): void {
  for (const item of items) {
    if (item.kind !== 'pull-request' || item.mergeable !== 'MERGEABLE') continue
    if (refreshMemo.get(repoId, item.number) !== undefined) refreshMemo.clear(repoId, item.number)
  }
}

export function observationsOf(params: ObservationsOfParams): readonly TickObservation[] {
  const { repoId, items, claims, held, viewer, refreshMemo, checkDispositions } = params
  const itemByNumber = new Map(items.map((item) => [item.number, item] as const))

  clearResolvedRefreshMemos(items, repoId, refreshMemo)

  return [
    ...livenessResetObservations(claims, itemByNumber, viewer),
    ...escalationObservations(held, itemByNumber, viewer),
    ...refreshObservations(held, items, viewer, repoId, refreshMemo, checkDispositions),
    ...withdrawApprovalObservations(items, viewer, checkDispositions),
  ]
}
