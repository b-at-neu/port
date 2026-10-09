// The trigger-key to stage-agent map, pinned by scripts/checks/desktop-tick.ts against
// plugins/port/data/labels.json's own trigger-role keys, both directions.
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

/** The in-flight-key to stage-agent map: `plan.ts`'s `claimsOf` uses this to recognize a
 *  dispatcher session's own `started` task as a live match. Pinned against liveness.ts both directions. */
export const AGENT_FOR_IN_FLIGHT: Readonly<Partial<Record<LabelKey, StageAgent>>> = {
  planning: 'plan',
  inProgress: 'impl',
  reviewing: 'review',
  revising: 'revise',
  refreshing: 'revise',
}

/** The one label pair sanctioned to sit beside each other. Transcribed byte-for-byte from
 *  scripts/port-tick/reconcile.ts's own REFRESH_PAIR, pinned both directions. */
export const REFRESH_PAIR: readonly LabelKey[] = ['refreshBranch', 'refreshing']
