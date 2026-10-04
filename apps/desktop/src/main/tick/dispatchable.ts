// The dispatch gate (#110, #314) — the only function that turns a
// `TickReport` into a set anything may act on. Pure: no `gh`, no filesystem,
// no timer. `main/tick/plan.ts` is deliberately untouched — a repository's
// run state is a per-repository fact read fresh by the caller, not a
// per-repository tick decision, and `TickReport` keeps reporting what *would*
// dispatch while draining or paused (ENGINEERING §4: the tick fails closed on
// actions, never on reporting). #106's own dispatcher is the one consumer
// this exists for — it must never read `report.actionable` directly.
import type { RunState } from '../../shared/dispatch/types'
import type { TickActionable, TickObservation, TickReport } from '../../shared/tick/types'

export function dispatchableFrom(report: TickReport, runState: RunState): readonly TickActionable[] {
  if (runState !== 'dispatching') return []
  if (report.blind !== null) return []
  return report.actionable
}

/** The write-bearing subset of `report.observations` (#292) — the same gate
 *  `dispatchableFrom` already is for `.actionable`, and the only function
 *  under `main/` allowed to read `.observations` at all. `refresh-deferred`
 *  authorises no write of its own (the board's hover state is its only
 *  consumer), so it never reaches the observation pass. */
export function observableFrom(report: TickReport, runState: RunState): readonly TickObservation[] {
  if (runState !== 'dispatching') return []
  if (report.blind !== null) return []
  return report.observations.filter((o) => o.kind !== 'refresh-deferred')
}
