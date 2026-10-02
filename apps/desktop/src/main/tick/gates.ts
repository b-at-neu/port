// Pure: the review cycle-cap, zero-diff review gate, mergeability routing,
// and the refresh-wins veto, from plugins/port/docs/PIPELINE.md → "Check
// evidence" → "Zero-diff review", "Branch refresh" and
// plugins/port/skills/pipeline/SKILL.md → "Cycle cap", "Zero-diff review
// gate", "Mergeability gate", "Refresh sweep" — ported verbatim from
// scripts/port-tick/gates.ts's own `cycleCapExceeded`/`zeroDiffGate`/
// `mergeabilityRoute`/`refreshWins`, pinned against that file
// one-directionally (this app's own exports must each be either that file's
// export of the same name, or `codeReviewCount`, the one documented
// exception) by scripts/checks/desktop-tick.ts's dynamic import — the same
// idiom contention.ts already uses, narrowed to one direction since this
// file ports only 4 of that file's 7 functions (#265 adds
// `mergeabilityRoute`/`refreshWins` to the 2 #108 already ported;
// `refreshDecision`/`capRefreshes`/`approvedReverify` stay cockpit-only, per
// this ticket's own "Four writes stay cockpit-only"). Typed against local
// ReviewNode/CommentNode shapes; no import — no `node:` import, no
// `../platform`, the same self-contained rail contention.ts already states
// for `main/tick/` as a whole.

/** The two review-body fields either gate reads — a local, minimal shape
 *  rather than an import of `shared/github/types.ts`'s `ReviewNode`: this
 *  ticket's own `## Risks / notes` names `main/tick/` as a pure decision
 *  layer that never imports outside itself. */
export interface ReviewNode {
  readonly body: string
  readonly submittedAt?: string
  readonly commitOid?: string | null
}

export interface CommentNode {
  readonly body: string
  readonly createdAt: string
}

const CODE_REVIEW_PREFIX = '## Code Review'
const GATE_CLEARED_PREFIX = '## Gate cleared'

export type ZeroDiffAction = 'dispatch' | 'dispatch-once' | 'escalate'

/** A head a `## Code Review` has already been submitted against gets no
 *  second cycle unless the head moved, or the operator authorised exactly
 *  one more re-review through `unblock #N` (a `## Gate cleared` comment newer
 *  than that review). Verbatim port of `scripts/port-tick/gates.ts`'s own
 *  `zeroDiffGate`. */
export function zeroDiffGate({
  reviews,
  comments,
  headRefOid,
}: {
  readonly reviews: readonly ReviewNode[] | undefined
  readonly comments: readonly CommentNode[] | undefined
  readonly headRefOid: string
}): { readonly action: ZeroDiffAction } {
  const codeReviews = (reviews ?? []).filter((r) => r.body.startsWith(CODE_REVIEW_PREFIX))
  if (codeReviews.length === 0) return { action: 'dispatch' }

  const newest = codeReviews.reduce((a, b) => ((a.submittedAt ?? '') > (b.submittedAt ?? '') ? a : b))
  if ((newest.commitOid ?? null) !== headRefOid) return { action: 'dispatch' }

  const clearedAfter = (comments ?? []).some((c) => c.body.startsWith(GATE_CLEARED_PREFIX) && c.createdAt > (newest.submittedAt ?? ''))
  if (clearedAfter) return { action: 'dispatch-once' }

  return { action: 'escalate' }
}

/** The cap is unconditional — it fires at or above `cap` whatever the latest
 *  review said, since cycle 3+ can loop back here with a clean latest review
 *  (a rebase, an approval withdrawal, a liveness reset). Verbatim port of
 *  `scripts/port-tick/gates.ts`'s own `cycleCapExceeded`. */
export function cycleCapExceeded(reviews: readonly ReviewNode[] | undefined, cap: number): boolean {
  return codeReviewCount(reviews) >= cap
}

/** This app's own addition, not present in `scripts/port-tick/gates.ts` —
 *  the same count `cycleCapExceeded` computes internally, exposed for the
 *  board's own display need (the cycle count visible before the cap, per
 *  the ticket's own **UX states**). The one deliberate exception to the
 *  ported-name pin `scripts/checks/desktop-tick.ts` enforces below. */
export function codeReviewCount(reviews: readonly ReviewNode[] | undefined): number {
  return (reviews ?? []).filter((r) => r.body.startsWith(CODE_REVIEW_PREFIX)).length
}

export type MergeabilityAction = 'dispatch' | 'refresh' | 'hold'

/** `UNKNOWN` holds review dispatch one tick and dispatches on the second
 *  consecutive occurrence. `priorUnknownStreak` is however many consecutive
 *  ticks this pull request has already read `UNKNOWN` (0 the first time) —
 *  `main/tick/ledger.ts`'s `createUnknownStreaks` is this app's own
 *  process-scoped memo for it, the equivalent of the cockpit's
 *  `tickState.unknownStreak`. `mergeable` is typed `string` rather than
 *  `shared/github/types.ts`'s own `Mergeable` — this file takes no import,
 *  the same self-contained rail the header states for `main/tick/` as a
 *  whole — so the caller narrows at the edge. Verbatim port of
 *  `scripts/port-tick/gates.ts`'s own `mergeabilityRoute`. */
export function mergeabilityRoute(mergeable: string, priorUnknownStreak = 0): { readonly action: MergeabilityAction; readonly unknownStreak: number } {
  if (mergeable === 'MERGEABLE') return { action: 'dispatch', unknownStreak: 0 }
  if (mergeable === 'CONFLICTING') return { action: 'refresh', unknownStreak: 0 }
  if (priorUnknownStreak >= 1) return { action: 'dispatch', unknownStreak: 0 }
  return { action: 'hold', unknownStreak: priorUnknownStreak + 1 }
}

export type RefreshWinsResult = { readonly action: 'veto'; readonly label: 'refreshBranch' | 'refreshing' } | { readonly action: 'proceed' }

/** The missing veto #225 found: a pull request already claimed by a refresh
 *  (`refreshBranch`) or mid-refresh (`refreshing`) must never also be
 *  dispatched to review or revision in the same tick, or it ends up carrying
 *  two trigger labels at once. `refreshBranch`/`refreshing` are the full,
 *  all-owners arrays of item numbers currently carrying each label —
 *  carrying the label is an ownership-independent fact, so this is never
 *  narrowed to the viewer's own items. Verbatim port of
 *  `scripts/port-tick/gates.ts`'s own `refreshWins`. */
export function refreshWins({
  number,
  refreshBranch,
  refreshing,
}: {
  readonly number: number
  readonly refreshBranch: readonly number[]
  readonly refreshing: readonly number[]
}): RefreshWinsResult {
  if (refreshBranch.includes(number)) return { action: 'veto', label: 'refreshBranch' }
  if (refreshing.includes(number)) return { action: 'veto', label: 'refreshing' }
  return { action: 'proceed' }
}
