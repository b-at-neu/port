// The dispatch gate (#110) — the only function that turns a `TickReport`
// into a set anything may act on. Pure: no `gh`, no filesystem, no timer.
// `main/tick/plan.ts` is deliberately untouched — the drain gate is an
// app-wide fact, not a per-repository tick decision, and `TickReport` keeps
// reporting what *would* dispatch while draining (ENGINEERING §4: the tick
// fails closed on actions, never on reporting). #106's own dispatcher is the
// one consumer this exists for — it must never read `report.actionable`
// directly.
import type { DrainState } from '../../shared/dispatch/types'
import type { TickActionable, TickReport } from '../../shared/tick/types'

export function dispatchableFrom(report: TickReport, drain: DrainState): readonly TickActionable[] {
  if (drain.gate !== 'open') return []
  if (report.blind !== null) return []
  return report.actionable
}
