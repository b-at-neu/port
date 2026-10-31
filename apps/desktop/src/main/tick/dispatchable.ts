// The dispatch gate: the only function that turns a TickReport into a set anything may act on.
// Pure: no gh, no filesystem, no timer. The dispatcher must never read `report.actionable` directly.
import type { RunState } from '@/types/dispatch'
import type { TickActionable, TickAutoApproval, TickObservation, TickReport } from '@/types/tick'

export function dispatchableFrom(report: TickReport, runState: RunState): readonly TickActionable[] {
  if (runState !== 'dispatching') return []
  if (report.blind !== null) return []
  return report.actionable
}

/** The write-bearing subset of `report.observations`. `refresh-deferred` authorises no write of
 *  its own, so it never reaches the observation pass. */
export function observableFrom(report: TickReport, runState: RunState): readonly TickObservation[] {
  if (runState !== 'dispatching') return []
  if (report.blind !== null) return []
  return report.observations.filter((o) => o.kind !== 'refresh-deferred')
}

/** Every issue the auto-plan swap qualifies for, whatever the run state — a blind report authorises nothing. */
export function autoApprovalCandidatesFrom(report: TickReport): readonly TickAutoApproval[] {
  if (report.blind !== null) return []
  return report.autoApprovals
}

/** The auto-plan swap's own gate: draining must stand this down too. */
export function autoApprovableFrom(report: TickReport, runState: RunState): readonly TickAutoApproval[] {
  if (runState !== 'dispatching') return []
  return autoApprovalCandidatesFrom(report)
}
