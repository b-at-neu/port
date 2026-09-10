// Pure: mergeability routing, the refresh sweep's bounds, the zero-diff
// review gate, the unconditional cycle cap, and the approved re-verify's two
// authorising facts. Per plugins/port/docs/PIPELINE.md → "Check evidence",
// "Branch refresh" and plugins/port/skills/pipeline/SKILL.md → "Mergeability
// gate", "Refresh sweep", "Zero-diff review gate", "Cycle cap", "Approved
// pull requests".

/** `UNKNOWN` holds review dispatch one tick and dispatches on the second
 *  consecutive occurrence — `review-agent` re-checks mergeability itself
 *  before posting. `priorUnknownStreak` is however many consecutive ticks
 *  this pull request has already read `UNKNOWN` (0 the first time). */
export function mergeabilityRoute(mergeable, priorUnknownStreak = 0) {
  if (mergeable === 'MERGEABLE') return { action: 'dispatch', unknownStreak: 0 };
  if (mergeable === 'CONFLICTING') return { action: 'refresh', unknownStreak: 0 };
  if (priorUnknownStreak >= 1) return { action: 'dispatch', unknownStreak: 0 };
  return { action: 'hold', unknownStreak: priorUnknownStreak + 1 };
}

/** `refreshEntry` is `.temp/tick-state.json`'s `Refreshed` record for this
 *  pull request (`{ sha, count }`, the sha and count as of the *last*
 *  refresh this session dispatched), or `undefined` for one never refreshed
 *  this session. `currentSha` is the pull request's live `headRefOid`.
 *
 *  Same-SHA guard: refreshing again would change nothing when the current
 *  head still equals the sha this session already refreshed — escalate
 *  instead of repeating a no-op. Otherwise, at most 3 consecutive refreshes:
 *  a 4th in a row escalates too. */
export function refreshDecision(refreshEntry, currentSha) {
  if (refreshEntry && refreshEntry.sha === currentSha) {
    return { action: 'escalate', reason: 'same-sha', count: refreshEntry.count };
  }
  const priorCount = refreshEntry?.count ?? 0;
  const nextCount = priorCount + 1;
  if (nextCount >= 4) return { action: 'escalate', reason: 'consecutive-cap', count: nextCount };
  return { action: 'refresh', count: nextCount };
}

/** Caps a tick's refresh candidates at `maxPerTick` (default 5), oldest pull
 *  request number first — the remainder waits for the next tick. */
export function capRefreshes(candidates, maxPerTick = 5) {
  const sorted = [...candidates].sort((a, b) => a.number - b.number);
  return { toRefresh: sorted.slice(0, maxPerTick), deferred: sorted.slice(maxPerTick) };
}

const CODE_REVIEW_PREFIX = '## Code Review';
const GATE_CLEARED_PREFIX = '## Gate cleared';

/** A head a `## Code Review` has already been submitted against gets no
 *  second cycle unless the head moved, or the operator authorised exactly
 *  one more re-review through `unblock #N` (a `## Gate cleared` comment newer
 *  than that review). `reviews` and `comments` are the `readyForReview`
 *  alias's own fields — no extra round trip. */
export function zeroDiffGate({ reviews, comments, headRefOid }) {
  const codeReviews = (reviews ?? []).filter((r) => r.body?.startsWith(CODE_REVIEW_PREFIX));
  if (codeReviews.length === 0) return { action: 'dispatch' };

  const newest = codeReviews.reduce((a, b) => (a.submittedAt > b.submittedAt ? a : b));
  if (newest.commit?.oid !== headRefOid) return { action: 'dispatch' };

  const clearedAfter = (comments ?? []).some(
    (c) => c.body?.startsWith(GATE_CLEARED_PREFIX) && c.createdAt > newest.submittedAt,
  );
  if (clearedAfter) return { action: 'dispatch-once' };

  return { action: 'escalate' };
}

/** The cap is unconditional — it fires at or above `reviewCycleCap` whatever
 *  the latest review said, since cycle 3+ can loop back here with a clean
 *  latest review (a rebase, an approval withdrawal, a liveness reset). */
export function cycleCapExceeded(reviews, cap) {
  const count = (reviews ?? []).filter((r) => r.body?.startsWith(CODE_REVIEW_PREFIX)).length;
  return count >= cap;
}

/** The `<labels.approved>` never-touch rail's exactly two authorising facts,
 *  read from `verdict` (checks.mjs's `rollupVerdict`, already excluding the
 *  approval-gate carve-out) and `mergeable`. A red check withdraws approval;
 *  `CONFLICTING` only adds the refresh label, leaving approval in place,
 *  since a clean rebase does not change the diff that was approved. */
export function approvedReverify({ verdict, mergeable }) {
  if (verdict.red.length > 0) return { action: 'withdraw', red: verdict.red };
  if (mergeable === 'CONFLICTING') return { action: 'refresh-in-place' };
  if (verdict.pending || mergeable === 'UNKNOWN') return { action: 'wait' };
  return { action: 'announce-ready', green: verdict.green };
}
