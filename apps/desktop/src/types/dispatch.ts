import type { BoardSnapshot } from '@/types/board'
import type { RegistryDeps } from '@/types/registry'
import type { AutoApprovePlanParams, ReadyEntry, EscalateToHumanParams, EscalateToHumanResult, ApplyObservationParams, ApplyObservationResult, ApplyItemActionParams } from '@/types/actions'
import type { TickActionable, EndedStage, DispatchLedger, RefreshMemo, TickObservation } from '@/types/tick'
import type { HostedStore } from '@/types/hosting'
import type { FetchItemsByNumberParams, ItemsByNumberFetch } from '@/types/github'
import type { ReposListResponse } from '@/types/ipc'
import type { GitRunner, PathOps, FileFailureKind } from '@/types/platform'
import type { LabelKey } from '@/utils/labels/vocabulary'

export type BudgetGateFailure = { readonly ok: false; readonly kind: 'unavailable' | 'failed'; readonly message: string }

export interface OwnershipDeps {
  readonly repoRoot: string
  readonly git?: GitRunner
  readonly pathOps?: PathOps
}

export type OwnershipWriteFailureKind = Exclude<FileFailureKind, 'unparseable'>

// Renderer-safe contract for operator control over dispatch: per-repository run state (run/drain/pause) and halt everything. No import here may reach a Node builtin.
import type { PipelineItemKind } from '@/types/github'
import type { ItemActionResult } from '@/types/actions'
import type { RepoId } from '@/utils/repos'
import type { StageAgent, TickObservationKind } from '@/types/tick'
import type { WriteOutcome } from '@/types/writes'
import type { StageOutcome } from '@/types/stage-session'
import type { SessionKey } from '@/types/hosting'
import type { InterruptedStage, StageDenial } from '@/types/stage'

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

/** `take-over` overwrites a `terminal` ownership record, reached only from the confirmed Take over dialog. There is no `halt` command any more — `HaltReport`/`haltDispatch` still exist, scoped to one repository by `pause`. */
export const DISPATCH_COMMANDS = [...RUN_COMMANDS, 'take-over'] as const
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

/** `'dispatch:control'`'s response. `run`/`drain`/`take-over` take ownership first; `drain`'s own write failure surfaces as `persisted: false`. `pause` is never refused outright — a failed write surfaces inside `report` instead. */
export type DispatchControlResult =
  | { readonly ok: true; readonly command: 'run'; readonly repoId: RepoId; readonly runState: RepoRunState }
  | { readonly ok: false; readonly command: 'run'; readonly repoId: RepoId; readonly reason: 'terminal-owned' | 'ownership-unreadable' | 'unwritable' | 'unreadable'; readonly message?: string; readonly since?: string; readonly path?: string }
  | { readonly ok: true; readonly command: 'drain'; readonly repoId: RepoId; readonly runState: RepoRunState; readonly persisted: boolean }
  | { readonly ok: false; readonly command: 'drain'; readonly repoId: RepoId; readonly reason: 'terminal-owned' | 'ownership-unreadable' | 'unwritable' | 'unreadable'; readonly message?: string; readonly since?: string; readonly path?: string }
  | { readonly ok: true; readonly command: 'pause'; readonly repoId: RepoId; readonly runState: RepoRunState; readonly report: HaltReport; readonly released: boolean }
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
  /** `null` until the launcher classifies a hand-back for this record's session; never set for a `failed` record. */
  readonly outcome: StageOutcome | null
  /** `null` for a `failed` record — no session was ever created to key. */
  readonly sessionKey: SessionKey | null
  readonly claudeSessionId: string | null
  readonly operatorJoinedAt: string | null
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
  /** The sum of every tracked outcome's `costUsd` this app run — `null` when none is known yet. Accounting only; the shipped ceiling stays wall-clock. */
  readonly costUsd: number | null
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
  /** Off-allowlist tool calls a stage session's policy denied, deduped by proposed rule and bounded to 20 — in-memory only, dropped on relaunch. */
  readonly denials: readonly StageDenial[]
  /** Stage sessions that ended without reaching a hand-back — survive a relaunch through `stage-sessions.json`, cleared once the item no longer carries the in-flight label. */
  readonly interrupted: readonly InterruptedStage[]
}

export interface AutoPlanner {
  consider(snapshot: BoardSnapshot): Promise<void>
}

export interface AutoPlannerDeps {
  readonly listRepositories: (deps: RegistryDeps) => Promise<ReposListResponse>
  readonly registryDeps: RegistryDeps
  readonly readOwnership: (params: ReadOwnershipParams) => Promise<OwnershipRead>
  /** The same per-repository run state `main/dispatch/dispatcher.ts` reads, never a second store. */
  readonly runState: (repoId: RepoId) => RunState
  readonly autoApprove: (params: AutoApprovePlanParams) => Promise<WriteOutcome>
  readonly auditDir: string
  readonly now: () => Date
}

export interface BudgetGate {
  readonly reset: (entry: ReadyEntry) => Promise<BudgetResetResult>
  readonly sweep: (entry: ReadyEntry, sets: { readonly live: readonly string[]; readonly completed: readonly string[] }) => Promise<BudgetSweepResult>
  readonly check: (entry: ReadyEntry, candidate: Pick<TickActionable, 'kind' | 'number' | 'agent'>, model: string) => Promise<BudgetCheckResult>
}

/** Never a `BudgetGateFailure` — a sweep failure must never block dispatch, only report it. */
export interface BudgetSweepResult {
  readonly line: string | null
  readonly problem: string | null
}

export type BudgetCheckResult = { readonly ok: true; readonly verdict: BudgetVerdict; readonly line: string } | BudgetGateFailure

export type BudgetResetResult = { readonly ok: true } | BudgetGateFailure

export type BudgetVerdict = 'allow' | 'exceeded' | 'hold'

export interface Dispatcher {
  /** Considers every ready repository, at most one pass each at a time. Never throws: a failure
   *  in one repository's pass is reported on its own status, never allowed to stop the others. */
  consider(snapshot: BoardSnapshot): Promise<void>
  status(): readonly RepoDispatchStatus[]
  /** `true` only when this loop found a `started` record for `(repoId, number)` and closing it did not throw. */
  stopFor(repoId: RepoId, number: number): Promise<boolean>
  /** Closes every remaining live stage session in a repository. */
  standDown(repoId: RepoId): Promise<boolean>
  liveStages(repoId: RepoId): readonly string[]
  /** `null` unless this app owns `repoId` — `main/tick/plan.ts`'s own `stageLiveness` input. */
  stageLiveness(repoId: RepoId): { readonly live: readonly string[]; readonly interrupted: readonly string[] } | null
  /** This repository's own ended stage-session records — `main/tick/plan.ts`'s own `endedStages` input. */
  endedStages(repoId: RepoId): readonly EndedStage[]
  /** Every live stage session across every repository, for the quit guard. */
  liveStageSessions(): readonly StageSessionSummary[]
  /** Stops new launches — called before `closeAll()` on quit. */
  shutdown(): void
  /** Records a stage launcher's hand-back classification against its matching record, by session key. A no-op if the key is not tracked. */
  recordOutcome(repoId: RepoId, sessionKey: SessionKey, outcome: StageOutcome): void
  /** `true` unless this app currently owns `repoId` — an unread repository (`'none'`) holds, the fail direction for `SESSION REQUIRED`. */
  holdsSessionRequired(repoId: RepoId): boolean
  /** Stage-denial bookkeeping: record (deduped by rule, bounded to 20), dismiss by id (operator's own Dismiss), or clear every denial proposing a given rule (once Allow succeeds or reports `already-allowed`). */
  recordDenial(repoId: RepoId, denial: StageDenial): void
  dismissDenial(repoId: RepoId, id: string): void
  clearDenialsFor(repoId: RepoId, rule: string): void
}

export interface CreateDispatcherParams {
  readonly store: HostedStore
  readonly ledger: DispatchLedger
  /** `null` is the honest state until a real launcher exists; a candidate sits visibly at `no-launcher`. */
  readonly launch: StageLauncher | null
  /** Read fresh every pass, never cached. */
  readonly runState: (repoId: RepoId) => RunState
  readonly readOwnership: (params: ReadOwnershipParams) => Promise<OwnershipRead>
  /** The re-take-on-relaunch rule: a persisted `run`/`draining` state with an `absent` ownership
   *  record takes ownership itself. */
  readonly takeOwnership: (params: TakeOwnershipParams) => Promise<TakeOwnershipResult>
  readonly fetchItemsByNumber: (params: FetchItemsByNumberParams) => Promise<ItemsByNumberFetch>
  readonly listRepositories: (registryDeps: RegistryDeps) => Promise<ReposListResponse>
  readonly registryDeps: RegistryDeps
  readonly budget: BudgetGate
  readonly escalate: (params: EscalateToHumanParams) => Promise<EscalateToHumanResult>
  readonly writeObservation: (params: ApplyObservationParams) => Promise<ApplyObservationResult>
  readonly refreshMemo: RefreshMemo
  readonly dirs: { readonly audit: string; readonly scratch: string }
  readonly onChange: () => void
  readonly now: () => Date
  /** Interrupted stage sessions for a repository, read from `main/stage/registry.ts` — `[]` when none is wired (tests, or before the registry loads). */
  readonly interrupted?: (repoId: RepoId) => readonly InterruptedStage[]
}

export interface HaltDispatchDeps {
  readonly applyItemAction: (params: ApplyItemActionParams) => Promise<ItemActionResult>
  /** This app's own per-item stop, called before every `applyItemAction` so the session is asked
   *  to stop before its label is touched. A no-op default for a caller with no dispatch loop. */
  readonly stopFor?: (repoId: RepoId, number: number) => Promise<boolean>
  /** This app's own whole-repository stand-down, once per in-scope ready entry after the per-item loop. */
  readonly standDown?: (repoId: RepoId) => Promise<boolean>
}

export interface HaltDispatchParams {
  readonly snapshot: BoardSnapshot
  /** One repository for `pause`, every ready repository for `halt`. An entry missing for a
   *  repository means every item there is skipped, never stopped. */
  readonly entries: readonly ReadyEntry[]
  readonly runStates: RunStateStore
  /** Written to `runStates` first, regardless of whether `entries` carries a ready entry for each. */
  readonly repoIds: readonly RepoId[]
  readonly auditDir: string
  readonly now: () => Date
}

// This app's own per-item launch record, kept internally by the loop.
export interface StageRecord {
  // `null` for a `failed` record — no session was ever created to key.
  readonly sessionKey: SessionKey | null
  readonly agent: StageAgent
  readonly number: number
  readonly kind: PipelineItemKind
  readonly trigger: LabelKey
  readonly state: 'started' | 'ended' | 'failed'
  readonly at: string
  readonly detail: string | null
  /** `null` until the launcher classifies a hand-back for this record's session; never set for a `failed` record. */
  readonly outcome: StageOutcome | null
  readonly claudeSessionId: string | null
  readonly operatorJoinedAt: string | null
}

export interface StageLauncher {
  launch(request: StageLaunchRequest): Promise<StageLaunchResult>
}

// `ok: true` promises the store holds a non-`ended` handle for `sessionKey`.
export type StageLaunchResult = { readonly ok: true; readonly sessionKey: SessionKey } | { readonly ok: false; readonly kind: 'at-capacity'; readonly limit: number } | { readonly ok: false; readonly kind: 'failed'; readonly message: string }

export interface StageLaunchRequest {
  readonly entry: ReadyEntry
  readonly agent: StageAgent
  readonly number: number
  readonly kind: PipelineItemKind
  readonly trigger: LabelKey
  readonly model: string
  readonly prompt: string
}

/** Every `TickObservation` kind this module writes — excludes the one report-only kind, `refresh-deferred`. */
export type WriteObservation = Exclude<TickObservation, { readonly kind: 'refresh-deferred' }>

export type TakeOwnershipResult = OwnershipWriteResult | { readonly ok: false; readonly kind: 'refused'; readonly verdict: Extract<OwnershipRead, { kind: 'terminal' | 'unreadable' }>; readonly path: string }

export interface TakeOwnershipParams extends OwnershipDeps {
  readonly repo: string
  /** Overwrites a `terminal` record — reached only from the confirmed Take over dialog. */
  readonly force?: boolean
  readonly now?: () => Date
}

export type OwnershipWriteResult = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly kind: OwnershipWriteFailureKind; readonly message: string; readonly path: string }

export interface ReadOwnershipParams extends OwnershipDeps {
  readonly repo: string
  readonly now?: () => Date
}

export type OwnershipRead =
  | { readonly kind: 'absent'; readonly path: string; readonly readAt: string }
  | { readonly kind: 'app'; readonly since: string; readonly path: string; readonly readAt: string }
  | { readonly kind: 'terminal'; readonly since: string; readonly path: string; readonly readAt: string }
  | { readonly kind: 'unreadable'; readonly message: string; readonly path: string; readonly readAt: string }

export interface QuitWarningCopy {
  readonly message: string
  readonly detail: string
  readonly confirmLabel: string
  readonly cancelLabel: string
}

// One live stage session, as the quit guard needs it — `repoName` is the
// display name (`owner/name`), printed verbatim by the copy below.
export interface StageSessionSummary {
  readonly agent: StageAgent
  readonly number: number
  readonly trigger: LabelKey
  readonly repoName: string
}

export interface RunStateStore {
  /** Synchronous, always answerable — a repository with no entry reads paused with `since: null`. */
  readonly current: (repoId: RepoId) => RepoRunState
  readonly status: () => RunStateStoreStatus
  readonly snapshot: (repoIds: readonly RepoId[]) => RunStatesSnapshot
  /** Resolves the on-disk state once, at startup. `registered` is called only for a v1 file, to
   *  migrate every currently-registered repository onto its own entry. */
  readonly load: (registered: () => Promise<readonly RepoId[] | null>) => Promise<void>
  /** A failed `set(..., 'paused' | 'draining', ...)` still applies in memory; a failed
   *  `set(..., RUN_TARGET.run, ...)` changes nothing at all. */
  readonly set: (repoIds: readonly RepoId[], state: RunState, at: string) => Promise<SetRunStateResult>
  readonly forget: (repoId: RepoId) => Promise<SetRunStateResult>
  readonly path: string
}

export type SetRunStateResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'unwritable' | 'unreadable'; readonly message: string }
