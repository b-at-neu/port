// The trigger-key to stage-agent map, one entry per trigger-role key of utils/labels/labels.legacy.json.
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { StageAgent } from '@/types/tick'

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

/** The forward direction of `AGENT_FOR_IN_FLIGHT` — `main/dispatch/stage/launcher.ts`'s own seam for the in-flight key a just-launched stage carries, disambiguating `revise`'s two in-flight keys by `trigger`. */
export function inFlightKeyFor(agent: StageAgent, trigger: LabelKey): LabelKey {
  if (trigger === 'refreshBranch') return 'refreshing'
  switch (agent) {
    case 'plan':
      return 'planning'
    case 'impl':
      return 'inProgress'
    case 'review':
      return 'reviewing'
    case 'revise':
      return 'revising'
  }
}
