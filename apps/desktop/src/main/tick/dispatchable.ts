// The dispatch gate: the only function that turns a TickReport into a set anything may act on.
// Pure: no gh, no filesystem, no timer. The dispatcher must never read `report.actionable` directly.
import type { RunState } from '../../shared/dispatch/types'
import type { TickActionable, TickAutoApproval, TickObservation, TickReport } from '../../shared/tick/types'

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

/** The auto-plan swap's own gate: draining must stand this down too, while a blind report
 *  authorises nothing regardless. */
export function autoApprovableFrom(report: TickReport, runState: RunState): readonly TickAutoApproval[] {
  if (runState !== 'dispatching') return []
  if (report.blind !== null) return []
  return report.autoApprovals
}
