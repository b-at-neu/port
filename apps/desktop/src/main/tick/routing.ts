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
