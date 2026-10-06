// Pure: the liveness diff against the dispatch log. `TaskList` is a model-only call; the
// model passes the live `description` strings in, and this module only classifies.

/** The dispatch-log `description` the harness records verbatim for an
 *  in-flight item. */
export const descriptionOf = (stage: string, number: number): string => `${stage} #${number}`;

/** True when `description` appears among `liveDescriptions` (the model's
 *  `TaskList` result, already reduced to its `description` strings). */
export function isLive(description: string, liveDescriptions: string[]): boolean {
  return liveDescriptions.includes(description);
}

export type LedgerState = 'dispatched' | 'suspect' | 'reset';

export interface LedgerRow {
  readonly state: LedgerState;
  readonly resets: number;
}

export type UnmatchedClass = 'no-record' | 'suspect' | 'reset' | 'capped';

export interface UnmatchedResult {
  readonly class: UnmatchedClass;
  readonly nextState?: LedgerState;
  readonly nextResets?: number;
}

/** Classifies one in-flight item with no live `TaskList` match against its dispatch-log row.
 *  At most one automatic reset per item per session: no row → `no-record`; `dispatched` → `suspect` (debounce one tick); `suspect` with `resets: 0` → `reset`; else `capped`. */
export function classifyUnmatched(logRow: LedgerRow | undefined): UnmatchedResult {
  if (!logRow) return { class: 'no-record' };
  if (logRow.state === 'dispatched') return { class: 'suspect', nextState: 'suspect', nextResets: logRow.resets ?? 0 };
  if (logRow.state === 'suspect' && (logRow.resets ?? 0) === 0) {
    return { class: 'reset', nextState: 'reset', nextResets: 1 };
  }
  return { class: 'capped' };
}

/** The five in-flight aliases' `livenessExpected` rows, read from `actionable` rather than the
 *  raw partition — a contradictory in-flight item is never cross-checked or auto-reset. */
export function buildLivenessExpected(actionable: Record<string, { mine: { readonly number: number }[] }>, labels: Record<string, string>): { readonly item: number; readonly labelKey: string; readonly label: string; readonly stage: string }[] {
  const specs: Array<[string, string, string]> = [
    ['planning', 'planning', 'plan-agent'],
    ['inProgress', 'inProgress', 'impl-agent'],
    ['reviewing', 'reviewing', 'review-agent'],
    ['revising', 'revising', 'revise-agent'],
    ['refreshing', 'refreshing', 'revise-agent'],
  ];
  return specs.flatMap(([alias, labelKey, stage]) =>
    (actionable[alias]?.mine ?? []).map((n) => ({ item: n.number, labelKey, label: labels[labelKey] ?? labelKey, stage })),
  );
}

/** The retry mapping from an in-flight label back to its trigger label, keyed by config label key. */
export const RETRY_TRIGGER: Readonly<Record<string, string>> = {
  planning: 'ready',
  inProgress: 'planApproved',
  reviewing: 'readyForReview',
  revising: 'needsRevision',
  refreshing: 'refreshBranch',
};

/** A `"session limit"`/`"resets at"`-shaped message — takes precedence over ordinary stalling. */
export function isUsageLimitMessage(text: string | null | undefined): boolean {
  return /session limit|resets at/i.test(text ?? '');
}
