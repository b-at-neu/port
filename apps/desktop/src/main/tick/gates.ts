// Pure: the review cycle-cap, zero-diff review gate, mergeability routing,
// the refresh-wins veto, the refresh sweep's own bounds, and the approved
// re-verify's two authorising facts, from plugins/port/docs/PIPELINE.md →
// "Check evidence" → "Zero-diff review", "Branch refresh" and
// plugins/port/skills/pipeline/SKILL.md → "Cycle cap", "Zero-diff review
// gate", "Mergeability gate", "Refresh sweep" — ported verbatim from
// scripts/port-tick/gates.ts's own `cycleCapExceeded`/`zeroDiffGate`/
// `mergeabilityRoute`/`refreshWins`/`refreshDecision`/`capRefreshes`/
// `approvedReverify`, pinned against that file one-directionally (this app's
// own exports must each be either that file's export of the same name, or
// `codeReviewCount`, the one documented exception) by
// scripts/checks/desktop-tick.ts's dynamic import — the same idiom
// contention.ts already uses. #292 ports the final three
// (`refreshDecision`/`capRefreshes`/`approvedReverify`), closing the "Four
// writes stay cockpit-only" gap #265 left. Typed against local
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

/** This pull request's own `Refreshed:` memo entry — the sha and count as of
 *  the *last* refresh this process dispatched (`main/tick/ledger.ts`'s
 *  `createRefreshMemo`, the app's own equivalent of
 *  `.temp/tick-state.json`'s `Refreshed` record). `undefined` for a pull
 *  request never refreshed this process. */
export interface RefreshMemoEntry {
  readonly sha: string
  readonly count: number
}

export type RefreshDecisionResult =
  | { readonly action: 'escalate'; readonly reason: 'same-sha' | 'consecutive-cap'; readonly count: number }
  | { readonly action: 'refresh'; readonly count: number }

/** Same-SHA guard: refreshing again would change nothing when the current
 *  head still equals the sha this process already refreshed — escalate
 *  instead of repeating a no-op. Otherwise, at most 3 consecutive refreshes:
 *  a 4th in a row escalates too. Verbatim port of
 *  `scripts/port-tick/gates.ts`'s own `refreshDecision`. */
export function refreshDecision(memoEntry: RefreshMemoEntry | undefined, currentSha: string): RefreshDecisionResult {
  if (memoEntry !== undefined && memoEntry.sha === currentSha) {
    return { action: 'escalate', reason: 'same-sha', count: memoEntry.count }
  }
  const priorCount = memoEntry?.count ?? 0
  const nextCount = priorCount + 1
  if (nextCount >= 4) return { action: 'escalate', reason: 'consecutive-cap', count: nextCount }
  return { action: 'refresh', count: nextCount }
}

export interface RefreshCandidate {
  readonly number: number
}

/** Caps a tick's refresh candidates at `maxPerTick` (default 5), oldest pull
 *  request number first — the remainder waits for the next pass. Verbatim
 *  port of `scripts/port-tick/gates.ts`'s own `capRefreshes`. */
export function capRefreshes<T extends RefreshCandidate>(candidates: readonly T[], maxPerTick = 5): { readonly toRefresh: readonly T[]; readonly deferred: readonly T[] } {
  const sorted = [...candidates].sort((a, b) => a.number - b.number)
  return { toRefresh: sorted.slice(0, maxPerTick), deferred: sorted.slice(maxPerTick) }
}

export interface ApprovedReverifyVerdict {
  readonly pending: boolean
  readonly zeroEvidence?: boolean
  readonly red: readonly { readonly name: string | null; readonly conclusion: string | null }[]
  readonly green: readonly (string | null)[]
}

export type ApprovedReverifyResult =
  | { readonly action: 'withdraw'; readonly red: ApprovedReverifyVerdict['red'] }
  | { readonly action: 'refresh-in-place' }
  | { readonly action: 'wait' }
  | { readonly action: 'announce-ready'; readonly green: ApprovedReverifyVerdict['green'] }

/** The `<labels.approved>` never-touch rail's exactly two authorising facts,
 *  read from `verdict` (`checks.ts`'s `rollupVerdict`, already excluding the
 *  approval-gate carve-out) and `mergeable`. A red check withdraws approval;
 *  `CONFLICTING` only adds the refresh label, leaving approval in place,
 *  since a clean rebase does not change the diff that was approved.
 *  Verbatim port of `scripts/port-tick/gates.ts`'s own `approvedReverify`. */
export function approvedReverify({ verdict, mergeable }: { readonly verdict: ApprovedReverifyVerdict; readonly mergeable: string | null }): ApprovedReverifyResult {
  if (verdict.red.length > 0) return { action: 'withdraw', red: verdict.red }
  if (mergeable === 'CONFLICTING') return { action: 'refresh-in-place' }
  if (verdict.pending || mergeable === 'UNKNOWN') return { action: 'wait' }
  return { action: 'announce-ready', green: verdict.green }
}
