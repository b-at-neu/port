// #313: the auto-plan swap's own tick-side decision — honouring the
// cockpit's unprompted `autoPlan` swap (`docs/COORDINATION.md` → "The
// decision") when this app holds the `plan-gate` claim instead. Pure: no
// `gh`, no claim read, no write — `main/dispatch/auto-plan.ts`'s own
// snapshot consumer reads the claim and performs the write.
import type { ReconciledItem } from '../../shared/state/types'
import type { TickAutoApproval } from '../../shared/tick/types'
import { partitionOwnership } from '../../../../../scripts/port-tick/classify'

/** An item qualifies when it carries `autoPlan`, its `stages` are exactly
 *  one entry at `planReview` (so a contradictory item — one also carrying
 *  another role-bearing label — never qualifies), and the viewer is among
 *  its assignees. `sessionRequired` is deliberately ignored, per the
 *  cockpit's own rule (PIPELINE.md → "The route" step 1): the swap still
 *  happens, and `planTick` already holds a session-required `planApproved`
 *  item as `session-required`, so nothing dispatches it regardless. */
export function autoApprovalsOf(items: readonly ReconciledItem[], viewer: string | null): readonly TickAutoApproval[] {
  const candidates = items.filter((item) => item.kind === 'issue' && item.autoPlan && item.stages.length === 1 && item.stages[0]?.key === 'planReview')
  const { mine } = partitionOwnership(candidates, viewer, (item) => item.assignees)
  return mine.map((item) => ({ number: item.number }))
}
