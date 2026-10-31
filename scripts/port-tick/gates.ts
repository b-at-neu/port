// Pure: mergeability routing, refresh-sweep bounds, zero-diff, cycle cap,
// and approved re-verify. A leaf module — `wire.ts` adapts the raw shape.

/** The two review-body fields either gate reads. */
export interface ReviewNode {
  readonly body: string;
  readonly submittedAt?: string;
  readonly commitOid?: string | null;
}

export interface CommentNode {
  readonly body: string;
  readonly createdAt: string;
}

const CODE_REVIEW_PREFIX = '## Code Review';
const GATE_CLEARED_PREFIX = '## Gate cleared';

/** The `## Code Review` count a pull request's reviews carry, exposed so a caller can
 *  display the cycle before the cap fires. */
export function codeReviewCount(reviews: readonly ReviewNode[] | undefined): number {
  return (reviews ?? []).filter((r) => r.body.startsWith(CODE_REVIEW_PREFIX)).length;
}

const CHECK_ONLY_PREFIX = 'Blocked only by checks:';
const CHECK_ONLY_LINE = /^Blocked only by checks: `[^`]+`(, `[^`]+`)*$/;

/** Minutes a check-only block is held at `ready for review` waiting for a re-run before it escalates. */
export const ZERO_DIFF_CHECK_HOLD_MINUTES = 120;

/** The check names a review body's line 3 marks as its only blockers, or null when the line is absent or malformed. */
export function checkOnlyNames(body: string): string[] | null {
  const line = body.split('\n')[2]?.trimEnd();
  if (line === undefined || !CHECK_ONLY_LINE.test(line)) return null;
  return [...line.slice(CHECK_ONLY_PREFIX.length).matchAll(/`([^`]+)`/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
}

export type ZeroDiffAction = 'dispatch' | 'dispatch-once' | 'recheck-dispatch' | 'hold-checks' | 'escalate';

export type CheckStatus = 'green' | 'pending' | 'red';

/** The rollup, already reduced: each check's status by name, and whether the whole rollup is clear of red and pending. */
export interface ZeroDiffChecks {
  readonly statuses: ReadonlyMap<string, CheckStatus>;
  readonly rollupClear: boolean;
  readonly now: string | null;
}

export interface ZeroDiffFacts {
  readonly checks: readonly string[];
  readonly sha: string;
  readonly cycle: number;
  readonly state: 'pending' | 'red';
  readonly escalateAt?: string;
}

/** A reviewed head gets no second cycle unless it moved or a newer `## Gate cleared` authorised one;
 *  a check-only block holds then re-reviews once, and a missing `checks` or clock escalates. */
export function zeroDiffGate({
  reviews,
  comments,
  headRefOid,
  checks,
}: {
  readonly reviews: readonly ReviewNode[] | undefined;
  readonly comments: readonly CommentNode[] | undefined;
  readonly headRefOid: string;
  readonly checks?: ZeroDiffChecks;
}): { readonly action: ZeroDiffAction; readonly facts?: ZeroDiffFacts } {
  const codeReviews = (reviews ?? []).filter((r) => r.body.startsWith(CODE_REVIEW_PREFIX));
  if (codeReviews.length === 0) return { action: 'dispatch' };

  const newest = codeReviews.reduce((a, b) => ((a.submittedAt ?? '') > (b.submittedAt ?? '') ? a : b));
  if ((newest.commitOid ?? null) !== headRefOid) return { action: 'dispatch' };

  const clearedAfter = (comments ?? []).some((c) => c.body.startsWith(GATE_CLEARED_PREFIX) && c.createdAt > (newest.submittedAt ?? ''));
  if (clearedAfter) return { action: 'dispatch-once' };

  const named = checkOnlyNames(newest.body);
  const reviewsOnHead = codeReviews.filter((r) => (r.commitOid ?? null) === headRefOid).length;
  if (named === null || checks === undefined || reviewsOnHead !== 1) return { action: 'escalate' };

  const present: CheckStatus[] = [];
  for (const n of named) {
    const status = checks.statuses.get(n);
    if (status === undefined) return { action: 'escalate' };
    present.push(status);
  }

  const cycle = codeReviewCount(reviews);
  const facts = { checks: named, sha: headRefOid, cycle };

  if (present.every((s) => s === 'green')) {
    return checks.rollupClear ? { action: 'recheck-dispatch', facts: { ...facts, state: 'pending' } } : { action: 'escalate' };
  }
  if (present.some((s) => s === 'pending')) return { action: 'hold-checks', facts: { ...facts, state: 'pending' } };

  const submitted = Date.parse(newest.submittedAt ?? '');
  const now = checks.now === null ? Number.NaN : Date.parse(checks.now);
  if (Number.isNaN(submitted) || Number.isNaN(now)) return { action: 'escalate' };
  const deadline = submitted + ZERO_DIFF_CHECK_HOLD_MINUTES * 60_000;
  if (now >= deadline) return { action: 'escalate' };
  return { action: 'hold-checks', facts: { ...facts, state: 'red', escalateAt: new Date(deadline).toISOString() } };
}

const CYCLE_GRANT_LINE = '### Cycle grant';

/** Operator-authorised extra cycles recorded — one per `## Gate cleared` comment carrying a
 *  `### Cycle grant` line. `comments` undefined means zero grants, fail closed. */
export function cycleGrantCount(comments: readonly CommentNode[] | undefined): number {
  return (comments ?? []).filter(
    (c) => c.body.startsWith(GATE_CLEARED_PREFIX) && c.body.split('\n').some((line) => line.trim() === CYCLE_GRANT_LINE),
  ).length;
}

/** Unconditional — fires at or above the effective cap whatever the latest review said.
 *  `comments` optional; absent means zero grants, fail closed. */
export function cycleCapExceeded(reviews: readonly ReviewNode[] | undefined, cap: number, comments?: readonly CommentNode[]): boolean {
  return codeReviewCount(reviews) >= cap + cycleGrantCount(comments);
}

export type MergeabilityAction = 'dispatch' | 'refresh' | 'hold';

/** `UNKNOWN` holds review dispatch one tick, dispatches on the second consecutive occurrence.
 *  `priorUnknownStreak` counts consecutive ticks already read `UNKNOWN` (0 the first time). */
export function mergeabilityRoute(mergeable: string, priorUnknownStreak = 0): { readonly action: MergeabilityAction; readonly unknownStreak: number } {
  if (mergeable === 'MERGEABLE') return { action: 'dispatch', unknownStreak: 0 };
  if (mergeable === 'CONFLICTING') return { action: 'refresh', unknownStreak: 0 };
  if (priorUnknownStreak >= 1) return { action: 'dispatch', unknownStreak: 0 };
  return { action: 'hold', unknownStreak: priorUnknownStreak + 1 };
}

export type RefreshWinsResult = { readonly action: 'veto'; readonly label: 'refreshBranch' | 'refreshing' } | { readonly action: 'proceed' };

/** A pull request already claimed by or mid-refresh must never also be dispatched to review
 *  or revision in the same tick. `refreshBranch`/`refreshing` are all-owners item arrays — carrying the label is ownership-independent. */
export function refreshWins({
  number,
  refreshBranch,
  refreshing,
}: {
  readonly number: number;
  readonly refreshBranch: readonly number[];
  readonly refreshing: readonly number[];
}): RefreshWinsResult {
  if (refreshBranch.includes(number)) return { action: 'veto', label: 'refreshBranch' };
  if (refreshing.includes(number)) return { action: 'veto', label: 'refreshing' };
  return { action: 'proceed' };
}

export interface RefreshMemoEntry {
  readonly sha: string;
  readonly count: number;
}

export type RefreshDecisionResult =
  | { readonly action: 'escalate'; readonly reason: 'same-sha' | 'consecutive-cap'; readonly count: number }
  | { readonly action: 'refresh'; readonly count: number };

/** `memoEntry` is the sha and count as of the last refresh this session dispatched, or
 *  `undefined` if never refreshed. Same-SHA guard: escalate rather than repeat a no-op. At most 3 consecutive refreshes; a 4th escalates too. */
export function refreshDecision(memoEntry: RefreshMemoEntry | null | undefined, currentSha: string): RefreshDecisionResult {
  if (memoEntry != null && memoEntry.sha === currentSha) {
    return { action: 'escalate', reason: 'same-sha', count: memoEntry.count };
  }
  const priorCount = memoEntry?.count ?? 0;
  const nextCount = priorCount + 1;
  if (nextCount >= 4) return { action: 'escalate', reason: 'consecutive-cap', count: nextCount };
  return { action: 'refresh', count: nextCount };
}

export interface RefreshCandidate {
  readonly number: number;
}

/** Caps a tick's refresh candidates at `maxPerTick` (default 5), oldest number first. */
export function capRefreshes<T extends RefreshCandidate>(candidates: readonly T[], maxPerTick = 5): { readonly toRefresh: readonly T[]; readonly deferred: readonly T[] } {
  const sorted = [...candidates].sort((a, b) => a.number - b.number);
  return { toRefresh: sorted.slice(0, maxPerTick), deferred: sorted.slice(maxPerTick) };
}

export interface ApprovedReverifyVerdict {
  readonly pending: boolean;
  readonly zeroEvidence?: boolean;
  readonly red: readonly { readonly name: string | null; readonly conclusion: string | null }[];
  readonly green: readonly (string | null)[];
}

export type ApprovedReverifyResult =
  | { readonly action: 'withdraw'; readonly red: ApprovedReverifyVerdict['red'] }
  | { readonly action: 'refresh-in-place' }
  | { readonly action: 'wait' }
  | { readonly action: 'announce-ready'; readonly green: ApprovedReverifyVerdict['green'] };

/** The `<labels.approved>` rail's two authorising facts. A red check withdraws approval;
 *  `CONFLICTING` only adds the refresh label, leaving approval in place. */
export function approvedReverify({ verdict, mergeable }: { readonly verdict: ApprovedReverifyVerdict; readonly mergeable: string | null }): ApprovedReverifyResult {
  if (verdict.red.length > 0) return { action: 'withdraw', red: verdict.red };
  if (mergeable === 'CONFLICTING') return { action: 'refresh-in-place' };
  if (verdict.pending || mergeable === 'UNKNOWN') return { action: 'wait' };
  return { action: 'announce-ready', green: verdict.green };
}
