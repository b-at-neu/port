// Pure: the liveness diff against the dispatch log.

/** The dispatch-log `description` recorded for an in-flight item. */
export const descriptionOf = (stage: string, number: number): string => `${stage} #${number}`

export function isLive(description: string, liveDescriptions: string[]): boolean {
  return liveDescriptions.includes(description)
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

/** A session-limit message takes precedence over ordinary stalling. */
export function isUsageLimitMessage(text: string | null | undefined): boolean {
  return /session limit|resets at/i.test(text ?? '')
}
