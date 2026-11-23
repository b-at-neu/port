// Pure: the liveness diff against the dispatch log.

/** The dispatch-log `description` recorded for an in-flight item. */
export const descriptionOf = (stage: string, number: number): string => `${stage} #${number}`

export function isLive(description: string, liveDescriptions: string[]): boolean {
  return liveDescriptions.includes(description)
}

export type LedgerState = 'dispatched' | 'suspect' | 'reset'

export interface LedgerRow {
  readonly state: LedgerState
  readonly resets: number
}

export type UnmatchedClass = 'no-record' | 'suspect' | 'reset' | 'capped'

export interface UnmatchedResult {
  readonly class: UnmatchedClass
  readonly nextState?: LedgerState
  readonly nextResets?: number
}

/** At most one automatic reset per item per session: no row is `no-record`, `dispatched` is `suspect` (debounced one tick), `suspect` with no resets is `reset`, else `capped`. */
export function classifyUnmatched(logRow: LedgerRow | undefined): UnmatchedResult {
  if (!logRow) return { class: 'no-record' }
  if (logRow.state === 'dispatched') return { class: 'suspect', nextState: 'suspect', nextResets: logRow.resets ?? 0 }
  if (logRow.state === 'suspect' && (logRow.resets ?? 0) === 0) {
    return { class: 'reset', nextState: 'reset', nextResets: 1 }
  }
  return { class: 'capped' }
}

/** The five in-flight aliases' expected-liveness rows, read from `actionable` so a contradictory item is never auto-reset. */
export function buildLivenessExpected(actionable: Record<string, { mine: { readonly number: number }[] }>, labels: Record<string, string>): { readonly item: number; readonly labelKey: string; readonly label: string; readonly stage: string }[] {
  const specs: Array<[string, string, string]> = [
    ['planning', 'planning', 'plan-agent'],
    ['inProgress', 'inProgress', 'impl-agent'],
    ['reviewing', 'reviewing', 'review-agent'],
    ['revising', 'revising', 'revise-agent'],
    ['refreshing', 'refreshing', 'revise-agent'],
  ]
  return specs.flatMap(([alias, labelKey, stage]) => (actionable[alias]?.mine ?? []).map((n) => ({ item: n.number, labelKey, label: labels[labelKey] ?? labelKey, stage })))
}

/** The retry mapping from an in-flight label key back to its trigger label key. */
export const RETRY_TRIGGER: Readonly<Record<string, string>> = {
  planning: 'ready',
  inProgress: 'planApproved',
  reviewing: 'readyForReview',
  revising: 'needsRevision',
  refreshing: 'refreshBranch',
}

/** A session-limit message takes precedence over ordinary stalling. */
export function isUsageLimitMessage(text: string | null | undefined): boolean {
  return /session limit|resets at/i.test(text ?? '')
}
