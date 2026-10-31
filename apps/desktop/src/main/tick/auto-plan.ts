// Pure decision for the cockpit's unprompted `autoPlan` swap; `main/dispatch/auto-plan.ts` reads the claim and writes.
import type { AutoPlanStatus } from '@/types/board'
import type { DispatchOwner, RepoDispatchStatus, RunState } from '@/types/dispatch'
import type { ReconciledItem } from '@/types/state'
import type { TickAutoApproval, TickReport } from '@/types/tick'
import type { RepoId } from '@/utils/repos'
import { partitionOwnership } from '../../../../../scripts/port-tick/classify'
import { autoApprovableFrom, autoApprovalCandidatesFrom } from '@/main/tick/dispatchable'

/** Qualifies when carrying `autoPlan`, `stages` is exactly one entry at `planReview`, and the viewer is an assignee. */
export function autoApprovalsOf(items: readonly ReconciledItem[], viewer: string | null): readonly TickAutoApproval[] {
  const candidates = items.filter((item) => item.kind === 'issue' && item.autoPlan && item.stages.length === 1 && item.stages[0]?.key === 'planReview')
  const { mine } = partitionOwnership(candidates, viewer, (item) => item.assignees)
  return mine.map((item) => ({ number: item.number }))
}

interface SwapParams {
  readonly report: TickReport
  readonly owner: DispatchOwner
  readonly runState: RunState
}

/** The one "will a swap run" predicate: an app owner needs a dispatching run state, a terminal cockpit runs it on its own tick, and an unknown owner runs nothing. */
export function autoPlanSwapCandidatesOf({ report, owner, runState }: SwapParams): readonly number[] {
  if (owner === 'app') return autoApprovableFrom(report, runState).map((approval) => approval.number)
  if (owner === 'terminal') return autoApprovalCandidatesFrom(report).map((approval) => approval.number)
  return []
}

/** The swap candidates minus the ones whose last attempt was refused. */
export function autoPlanApprovingOf(params: SwapParams & { readonly refused: ReadonlySet<number> }): readonly number[] {
  return autoPlanSwapCandidatesOf(params).filter((number) => !params.refused.has(number))
}

/** One entry per report; a report with no dispatch row gets none, failing toward the operator. */
export function autoPlanStatusOf(tick: readonly TickReport[], dispatch: readonly RepoDispatchStatus[], refusedOf: (repoId: RepoId) => ReadonlySet<number>): readonly AutoPlanStatus[] {
  const byRepo = new Map(dispatch.map((row) => [row.repoId, row] as const))
  return tick.map((report): AutoPlanStatus => {
    const row = byRepo.get(report.repoId)
    if (row === undefined) return { repoId: report.repoId, approving: [] }
    return { repoId: report.repoId, approving: autoPlanApprovingOf({ report, owner: row.owner, runState: row.runState, refused: refusedOf(report.repoId) }) }
  })
}
