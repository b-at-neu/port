// Pure: the liveness diff against the dispatch log, per
// plugins/port/docs/PIPELINE.md → "Liveness". `TaskList` itself is a model-
// only call (this engine cannot make it), so the model calls it and passes
// the live `description` strings in; this module only classifies.

/** The dispatch-log `description` the harness records verbatim for an
 *  in-flight item. */
export const descriptionOf = (stage, number) => `${stage} #${number}`;

/** True when `description` appears among `liveDescriptions` (the model's
 *  `TaskList` result, already reduced to its `description` strings). */
export function isLive(description, liveDescriptions) {
  return liveDescriptions.includes(description);
}

/** Classifies one in-flight item with no live `TaskList` match against its
 *  dispatch-log row (`{ state: 'dispatched'|'suspect'|'reset', resets }`, or
 *  `undefined` for an item this session never dispatched). At most one
 *  automatic reset per item per session — a crash loop reports instead of
 *  resetting forever:
 *
 *  - No row at all → `no-record`: this session cannot prove anything about
 *    it, report-only forever.
 *  - Row `dispatched` (first unmatched tick) → `suspect`: debounce one tick,
 *    change nothing.
 *  - Row `suspect`, still unmatched, `resets: 0` → `reset`: provably dead,
 *    safe to auto-reset. Redispatches next tick, never this one.
 *  - Already reset once and stalled again (`resets >= 1`) → `capped`:
 *    report, never reset a second time. */
export function classifyUnmatched(logRow) {
  if (!logRow) return { class: 'no-record' };
  if (logRow.state === 'dispatched') return { class: 'suspect', nextState: 'suspect', nextResets: logRow.resets ?? 0 };
  if (logRow.state === 'suspect' && (logRow.resets ?? 0) === 0) {
    return { class: 'reset', nextState: 'reset', nextResets: 1 };
  }
  return { class: 'capped' };
}

/** The retry mapping from an in-flight label back to its trigger label,
 *  keyed by the config label key (never the resolved name — the caller
 *  substitutes the resolved name). */
export const RETRY_TRIGGER = {
  planning: 'ready',
  inProgress: 'planApproved',
  reviewing: 'readyForReview',
  revising: 'needsRevision',
  refreshing: 'refreshBranch',
};

/** A `"session limit"`/`"resets at"`-shaped completion message — the usage-
 *  limit class, which takes precedence over ordinary stalling and resets
 *  every affected item regardless of its dispatch-log state. */
export function isUsageLimitMessage(text) {
  return /session limit|resets at/i.test(text ?? '');
}
