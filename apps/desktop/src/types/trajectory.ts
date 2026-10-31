// One line per ready repository per app poll — the desktop app's own twin to the cockpit's
// trajectory event. Type-only, no function.
import type { RepoId } from '@/utils/repos'
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { StageAgent, TickBlind, TickClaimClass, TickContention, TickHeldReason } from '@/types/tick'
import type { GitRunner, PathOps } from '@/types/platform'

export interface RecordTickDeps {
  readonly git?: GitRunner
  readonly pathOps?: PathOps
}

/** `stage` is `` `${agent}-agent` ``, the same string the cockpit's own `planned.dispatch`
 *  entries carry. */
interface DesktopDispatchEvent {
  readonly item: number
  readonly stage: string
  readonly agent: StageAgent
}

/** `trigger` is load-bearing: the parity diff buckets `unowned`/`other-operator` counts off it. */
interface DesktopHeldEvent {
  readonly item: number
  readonly reason: TickHeldReason
  readonly contention: TickContention | null
  readonly trigger: LabelKey
}

interface DesktopClaimEvent {
  readonly item: number
  readonly class: TickClaimClass
}

/** `blind` is never folded into an empty `dispatch`/`held`/`claims` — absence is reported, never
 *  rendered as agreement. */
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
