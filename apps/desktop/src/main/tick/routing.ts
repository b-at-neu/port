// The trigger-key to stage-agent map (#105) — exported for #106's own
// dispatch to consume rather than re-declared there. `scripts/checks/desktop-tick.ts`
// pins this against `plugins/port/data/labels.json`'s own `role: "trigger"`
// keys, both directions, so a label added or retired there cannot silently
// leave this map out of step.
import type { LabelKey } from '../../shared/labels/vocabulary'
import type { StageAgent } from '../../shared/tick/types'

export const AGENT_FOR_TRIGGER: Readonly<Partial<Record<LabelKey, StageAgent>>> = {
  ready: 'plan',
  planChangesRequested: 'plan',
  planApproved: 'impl',
  readyForReview: 'review',
  needsRevision: 'revise',
  refreshBranch: 'revise',
}

/** The in-flight-key to stage-agent map (#292) — `main/tick/plan.ts`'s
 *  `claimsOf` consumes this to recognize a dispatcher session's own
 *  `started` task (`"${agent} #${n}"`) as a live match, alongside a matched
 *  session scan hit. `scripts/checks/desktop-tick.ts` pins this against
 *  `scripts/port-tick/liveness.ts`'s own `buildLivenessExpected`
 *  `(labelKey, stage)` pairs, both directions. */
export const AGENT_FOR_IN_FLIGHT: Readonly<Partial<Record<LabelKey, StageAgent>>> = {
  planning: 'plan',
  inProgress: 'impl',
  reviewing: 'review',
  revising: 'revise',
  refreshing: 'revise',
}

/** The one label pair sanctioned to sit beside each other — never beside
 *  themselves twice over (`docs/PIPELINE.md` → "Label lifecycle" → "State
 *  invariant"). Transcribed byte-for-byte from
 *  `scripts/port-tick/reconcile.ts`'s own `REFRESH_PAIR`, pinned against it
 *  both directions by `scripts/checks/desktop-tick.ts`, the same idiom
 *  `scripts/checks/reconcile.ts` already uses to pin that file against
 *  `plugins/port/bin/artifacts.mjs`'s own `PR_REFRESH_KEYS`. */
export const REFRESH_PAIR: readonly LabelKey[] = ['refreshBranch', 'refreshing']
