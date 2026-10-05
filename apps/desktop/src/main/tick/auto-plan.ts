// Pure decision for the cockpit's unprompted `autoPlan` swap; `main/dispatch/auto-plan.ts` reads the claim and writes.
import type { ReconciledItem } from '../../shared/state/types'
import type { TickAutoApproval } from '../../shared/tick/types'
import { partitionOwnership } from '../../../../../scripts/port-tick/classify'

/** Qualifies when carrying `autoPlan`, `stages` is exactly one entry at `planReview`, and the viewer is an assignee. */
export function autoApprovalsOf(items: readonly ReconciledItem[], viewer: string | null): readonly TickAutoApproval[] {
  const candidates = items.filter((item) => item.kind === 'issue' && item.autoPlan && item.stages.length === 1 && item.stages[0]?.key === 'planReview')
  const { mine } = partitionOwnership(candidates, viewer, (item) => item.assignees)
  return mine.map((item) => ({ number: item.number }))
}
