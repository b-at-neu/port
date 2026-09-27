// The shape `main/trajectory/log.ts` appends, one line per ready repository
// per app poll (#111) — the desktop app's own twin to the cockpit's
// `scripts/port-tick/events.ts` `tick` event, built directly from one
// repository's `TickReport` (`main/tick/plan.ts`'s whole result) so the
// mapping to the cockpit's own `tickEventPayload` shape is mechanical rather
// than clever. Type-only, no function — the same shape every other
// `shared/*/types.ts` and `main/tick/`'s own consumers already take.
import type { RepoId } from '../../shared/repos'
import type { StageAgent, TickBlind, TickClaimClass, TickContention, TickHeldReason } from '../../shared/tick/types'

/** One dispatch candidate this poll's tick would have sent out — `stage` is
 *  `` `${agent}-agent` ``, the same string the cockpit's own `planned.dispatch`
 *  entries carry, so `scripts/port-tick/parity.ts` can compare the two
 *  without a translation table on either side. */
export interface DesktopDispatchEvent {
  readonly item: number
  readonly stage: string
  readonly agent: StageAgent
}

/** One held trigger-stage candidate — `reason`/`contention` copied straight
 *  off `TickHeld`, dropping `kind`/`trigger`, neither of which the parity
 *  diff needs. */
export interface DesktopHeldEvent {
  readonly item: number
  readonly reason: TickHeldReason
  readonly contention: TickContention | null
}

/** One in-flight claim's own resolution — `TickClaim` minus `kind`/
 *  `inFlight`/`retryKey`, the fields the parity diff has no cockpit-side
 *  counterpart for. */
export interface DesktopClaimEvent {
  readonly item: number
  readonly class: TickClaimClass
}

/** One repository, one poll. `blind` carries the same reason `TickReport`
 *  itself would report a blind tick for — never folded into an empty
 *  `dispatch`/`held`/`claims`, the same "absence is reported, never rendered
 *  as agreement" rule `docs/ENGINEERING.md` §4 states for the cockpit's own
 *  trajectory record. */
export interface DesktopTickEvent {
  readonly v: 1
  readonly ts: string
  readonly repo: string
  readonly repoId: RepoId
  readonly dispatch: readonly DesktopDispatchEvent[]
  readonly held: readonly DesktopHeldEvent[]
  readonly claims: readonly DesktopClaimEvent[]
  readonly blind: TickBlind | null
}
