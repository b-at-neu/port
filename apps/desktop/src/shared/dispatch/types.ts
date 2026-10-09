// Renderer-safe contract for operator control over dispatch: per-repository run state (run/drain/pause) and halt everything. No import here may reach a Node builtin.
import type { PipelineItemKind } from '../github/types'
import type { ItemActionResult } from '../actions/types'
import type { RepoId } from '../repos'
import type { StageAgent, TickObservationKind } from '../tick/types'
import type { WriteOutcome } from '../writes/types'

/** `dispatch.json`'s own per-repository run state — `dispatching`, `draining` (scoped to one repository), or `paused` (the hard stop: the transition into it also stops every in-flight agent). */
export const RUN_STATES = ['dispatching', 'draining', 'paused'] as const
export type RunState = (typeof RUN_STATES)[number]

/** The three per-repository operator commands — map onto `RUN_TARGET` 1:1, which is what `resolveDispatchControl` writes. */
export const RUN_COMMANDS = ['run', 'drain', 'pause'] as const
export type RunCommand = (typeof RUN_COMMANDS)[number]

export const RUN_TARGET: Readonly<Record<RunCommand, RunState>> = {
  run: 'dispatching',
  drain: 'draining',
  pause: 'paused',
}

/** `halt` carries no `repoId` at all — it pauses every registered repository. `take-over` overwrites a `terminal` ownership record, reached only from the confirmed Take over dialog. */
export const DISPATCH_COMMANDS = [...RUN_COMMANDS, 'halt', 'take-over'] as const
export type DispatchCommand = (typeof DISPATCH_COMMANDS)[number]

/** The run-state store's own read status — `unread` before the file has ever been read, so a not-yet-loaded store answers every repository as paused, never silently as open. */
export type RunStateStoreStatus = { readonly kind: 'unread' } | { readonly kind: 'loaded' } | { readonly kind: 'unreadable'; readonly message: string; readonly path: string }

/** One repository's own persisted run state — `since: null` means no saved entry at all, which reads as paused the same as an explicit `paused` entry. */
export interface RepoRunState {
  readonly repoId: RepoId
  readonly state: RunState
  readonly since: string | null
}

export interface RunStatesSnapshot {
  readonly store: RunStateStoreStatus
  readonly repositories: readonly RepoRunState[]
}

/** One in-flight item's own halt outcome. `stopped` mirrors `stopPlan`'s own `applied` write. `skipped` never reached `applyItemAction` at all. `refused` is any other `ItemActionResult` the write chokepoint returned. */
export type HaltItemOutcome =
  | {
      readonly kind: 'stopped'
      readonly number: number
      readonly itemKind: PipelineItemKind
      readonly repoId: RepoId
      readonly removedLabel: string
      readonly attachedAgent: string | null
      /** `true` when this halt also closed an app-launched stage session for this item — `false` otherwise, never omitted. */
      readonly stoppedTask: boolean
    }
  | {
      readonly kind: 'skipped'
      readonly number: number
      readonly itemKind: PipelineItemKind
      readonly repoId: RepoId
      readonly reason: 'session-required' | 'not-owned' | 'viewer-unknown'
      readonly owner: string | null
    }
  | { readonly kind: 'refused'; readonly number: number; readonly itemKind: PipelineItemKind; readonly repoId: RepoId; readonly result: ItemActionResult }

/** `haltDispatch`'s own report. `aborted` is the one outcome that never touched a single item's labels — the run-state write itself failed. `completed` always ran, even with an empty `items` list. */
export type HaltReport =
  | { readonly kind: 'aborted'; readonly reason: 'run-state-unwritable'; readonly message: string; readonly path: string }
  | { readonly kind: 'completed'; readonly items: readonly HaltItemOutcome[] }

/** `'dispatch:control'`'s response. `run`/`drain`/`take-over` take ownership first; `drain`'s own write failure surfaces as `persisted: false`. `pause`/`halt` are never refused outright — a failed write surfaces inside `report` instead. */
export type DispatchControlResult =
  | { readonly ok: true; readonly command: 'run'; readonly repoId: RepoId; readonly runState: RepoRunState }
  | { readonly ok: false; readonly command: 'run'; readonly repoId: RepoId; readonly reason: 'terminal-owned' | 'ownership-unreadable' | 'unwritable' | 'unreadable'; readonly message?: string; readonly since?: string; readonly path?: string }
  | { readonly ok: true; readonly command: 'drain'; readonly repoId: RepoId; readonly runState: RepoRunState; readonly persisted: boolean }
  | { readonly ok: false; readonly command: 'drain'; readonly repoId: RepoId; readonly reason: 'terminal-owned' | 'ownership-unreadable' | 'unwritable' | 'unreadable'; readonly message?: string; readonly since?: string; readonly path?: string }
  | { readonly ok: true; readonly command: 'pause'; readonly repoId: RepoId; readonly runState: RepoRunState; readonly report: HaltReport; readonly released: boolean }
  | { readonly ok: true; readonly command: 'halt'; readonly report: HaltReport; readonly released: boolean }
  | { readonly ok: true; readonly command: 'take-over'; readonly repoId: RepoId; readonly runState: RepoRunState }
  | { readonly ok: false; readonly command: 'take-over'; readonly repoId: RepoId; readonly reason: 'unwritable'; readonly message: string; readonly path: string }

/** Who runs the pipeline for one ready repository, read fresh off `.agents/cockpit.json` every pass, never cached. `absent` → `none`; `unreadable` stands on its own. */
export type DispatchOwner = 'app' | 'terminal' | 'none' | 'unreadable'

/** One stage-session launch this app's loop attempted, tracked from `started` through `ended` or `failed`. `detail` is set only on `failed`. Bounded to the newest 20 per repository. */
export interface DispatchRecord {
  readonly agent: StageAgent
  readonly number: number
  readonly kind: PipelineItemKind
  readonly state: 'started' | 'ended' | 'failed'
  readonly at: string
  readonly detail: string | null
}

/** This app's own dispatch state for one ready repository, rendered only while `owner === 'app'`. `idle` covers both "nothing launched yet" and "nothing to report"; `no-launcher` holds while candidates exist but no `StageLauncher` is wired. */
export type DispatcherState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'active'; readonly recent: readonly DispatchRecord[] }
  /** `commands.budget` is set, but the shipped script can't be run. Nothing dispatches while this holds — the gate that can't run must fail closed. */
  | { readonly kind: 'budget-unavailable'; readonly message: string }
  | { readonly kind: 'no-launcher' }
  | { readonly kind: 'at-capacity'; readonly limit: number; readonly waiting: number }

/** One candidate the budget gate acted on this pass, rendered as its own line, never folded into `DispatcherState` since several notes can coexist with one state. */
export type BudgetNote =
  | { readonly kind: 'held'; readonly number: number; readonly line: string }
  | { readonly kind: 'held-dispatched'; readonly number: number }
  | { readonly kind: 'escalated'; readonly number: number; readonly needsHumanLabel: string; readonly commentFailedMessage: string | null }
  | { readonly kind: 'escalation-failed'; readonly number: number; readonly needsHumanLabel: string; readonly triggerLabel: string; readonly outcome: WriteOutcome }
  | { readonly kind: 'gate-failed'; readonly number: number; readonly message: string }

/** One machine-observation write this app attempted this pass, bounded to the newest 20 per repository. `outcome` maps a raw `WriteOutcome`: `written`/`already`/`moved`/`refused`/`failed`. */
export interface ObservationRecord {
  readonly kind: TickObservationKind
  readonly number: number
  readonly itemKind: PipelineItemKind
  readonly at: string
  readonly outcome: 'written' | 'already' | 'moved' | 'refused' | 'failed'
  readonly comment: 'posted' | 'failed' | 'none'
}

/** One ready repository's own budget-gate status — `line` is the sweep's own session clause verbatim; `problem` is set only while the most recent sweep failed; `notes` is bounded to 20. */
export interface BudgetStatus {
  readonly line: string | null
  readonly problem: string | null
  readonly notes: readonly BudgetNote[]
}

/** `BoardSnapshot.dispatch`'s own one-row-per-ready-repository shape — `state` is always `{ kind: 'idle' }` when `owner !== 'app'`. */
export interface RepoDispatchStatus {
  readonly repoId: RepoId
  readonly owner: DispatchOwner
  readonly state: DispatcherState
  /** This repository's own persisted run state — the owner line appends " · draining"/" · paused" for the two non-dispatching values. */
  readonly runState: RunState
  /** The ownership record's own `since` — `null` unless `owner` is `'app'` or `'terminal'`. */
  readonly ownedSince: string | null
  /** Set only while `owner === 'unreadable'` — the read failure, for the "can't be read (<reason>)" copy. */
  readonly unreadableMessage: string | null
  /** `null` iff `commands.budget` is `null` — otherwise populated regardless of `owner`. */
  readonly budget: BudgetStatus | null
  /** The machine-observation writes this app has made for this repository, newest last — `[]` while `owner !== 'app'`, or before the first observation pass runs. */
  readonly observed: readonly ObservationRecord[]
}
