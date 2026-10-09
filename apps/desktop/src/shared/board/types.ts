// Pure types and constants for the board projection. No import here may reach a Node builtin or `src/main/`, so this file compiles under `typecheck:web`.
import type { RepoId } from '../repos'
import type { ItemStatus, PipelineState, ReconciledItem, RepositoryState, StageLabel } from '../state/types'
import type { ActionAvailability, DecisionAvailability, OperatorAction, OperatorDecision } from '../actions/types'
import type { TickReport } from '../tick/types'
import type { RepoDispatchStatus, RunStatesSnapshot } from '../dispatch/types'

/** The four sources the watcher polls independently; `itemStates` is a dependent re-check fired internally, never independently schedulable. */
export const SOURCE_KINDS = ['github', 'sessions', 'worktrees', 'denials'] as const

export type SourceKind = (typeof SOURCE_KINDS)[number]

/** GitHub is expensive; the three local reads are cheap and run far more often. Shared by the scheduler and the staleness rule so the two agree on "one interval old". */
export const SOURCE_BASE_INTERVAL_MS: Readonly<Record<SourceKind, number>> = {
  github: 60_000,
  sessions: 15_000,
  worktrees: 15_000,
  denials: 15_000,
}

/** Backoff doubles from a source's base interval up to this ceiling. */
export const BACKOFF_CEILING_MS = 15 * 60 * 1000

/** Below this many points remaining, the GitHub source defers to the window's own `resetAt` instead of a doubled guess. */
export const RATE_LIMIT_FLOOR = 200

/** A `stalled` verdict renders as `stalled` only when the GitHub read behind it is within `githubIntervalMs + STALE_GRACE_MS`, wide enough to absorb ordinary poll jitter. */
export const STALE_GRACE_MS = 30_000

export interface SourceHealth {
  readonly lastSuccessAt: string | null
  readonly lastAttemptAt: string | null
  readonly consecutiveFailures: number
  readonly lastError: string | null
  /** Base until a failure doubles it, reset to base on the next success. */
  readonly intervalMs: number
  /** Set only by a rate-limited GitHub failure — overrides the doubled-interval guess with the known reset instant. */
  readonly deferredUntil: string | null
}

export function initialHealth(kind: SourceKind): SourceHealth {
  return {
    lastSuccessAt: null,
    lastAttemptAt: null,
    consecutiveFailures: 0,
    lastError: null,
    intervalMs: SOURCE_BASE_INTERVAL_MS[kind],
    deferredUntil: null,
  }
}

/** One repository's own health across all four sources; `sessions` is the one machine-wide scan's health, copied onto every repository. */
export interface RepositoryHealth {
  readonly repoId: RepoId
  readonly github: SourceHealth
  readonly sessions: SourceHealth
  readonly worktrees: SourceHealth
  readonly denials: SourceHealth
}

export interface PollPolicy {
  readonly baseIntervalMs: Readonly<Record<SourceKind, number>>
  readonly backoffCeilingMs: number
  readonly rateLimitFloor: number
  readonly staleGraceMs: number
}

export const DEFAULT_POLL_POLICY: PollPolicy = {
  baseIntervalMs: SOURCE_BASE_INTERVAL_MS,
  backoffCeilingMs: BACKOFF_CEILING_MS,
  rateLimitFloor: RATE_LIMIT_FLOOR,
  staleGraceMs: STALE_GRACE_MS,
}

/** The one payload the watcher pushes and the renderer ever reads; `health` and `policy` are carried alongside `state` rather than folded into it. */
export interface BoardSnapshot {
  readonly state: PipelineState
  readonly health: readonly RepositoryHealth[]
  readonly policy: PollPolicy
  /** One `TickReport` per ready repository, computed inside `buildSnapshot()` from the same `PipelineState` above, never a second poll. */
  readonly tick: readonly TickReport[]
  /** Every registered repository's own run state, stamped onto every snapshot; defaults to an empty, paused run-state set when the watcher has no source wired. */
  readonly runStates: RunStatesSnapshot
  /** The watcher's one timer's next due instant — `null` once `stop()` has run, the honest rendering of "no wakeup scheduled". */
  readonly nextWakeupAt: string | null
  readonly emittedAt: string
  /** One row per ready repository, this app's own dispatcher state, computed inside `buildSnapshot()` from `dispatcher.status()`. `[]` when no dispatcher is wired. */
  readonly dispatch: readonly RepoDispatchStatus[]
}

export type GroupBy = 'stage' | 'repo'

/** A presentation verdict — the only value it may change is `stalled` → `in-flight`; it never rewrites `ReconciledItem.status` itself. */
export interface DisplayStatus {
  readonly status: ItemStatus
  readonly staleGithub: boolean
  readonly githubAgeMs: number | null
}

export interface BoardItemRow {
  readonly item: ReconciledItem
  readonly displayStatus: DisplayStatus
  readonly stageLabel: StageLabel | null
  /** `actionsFor`'s own result for this item, so the row renders from one already-computed value, never a second derivation client-side. */
  readonly actions: Readonly<Record<OperatorAction, ActionAvailability>>
  /** `decisionsFor`'s own result for this item, same rule as `actions` above. */
  readonly decisions: Readonly<Record<OperatorDecision, DecisionAvailability>>
}

export interface BoardGroup {
  /** The label `key` (grouped by stage) or the `RepoId` (grouped by repo), never a display name, so two repositories renaming a label still group together. */
  readonly key: string
  readonly name: string
  readonly rows: readonly BoardItemRow[]
}

export interface BoardRepositorySummary {
  readonly repoId: RepoId
  readonly displayName: string
  readonly waiting: number
  readonly inFlight: number
  readonly stalled: number
  /** `null` only when the worktree source has never returned a good read for this repository — never `0` standing in for "did not run". */
  readonly worktreeTotal: number | null
  /** The inspector's own burst copy, verbatim — `null` when nothing on this repository's denial log currently qualifies. */
  readonly denialBurst: string | null
}

export interface BoardProjection {
  readonly groupBy: GroupBy
  readonly groups: readonly BoardGroup[]
  /** Every row, sorted the same way `groups` orders them, but unlike `groups` never drops a row whose `stageLabel` matches no `LABEL_DEFAULTS` entry. */
  readonly rows: readonly BoardItemRow[]
  readonly notReady: readonly Extract<RepositoryState, { readonly ok: false }>[]
  readonly repositorySummaries: readonly BoardRepositorySummary[]
  readonly totalItems: number
  /** Every row whose `gate` action is available, from a repository with the `approvalGate` module on. Never populated when the module is off. */
  readonly ungated: readonly BoardItemRow[]
  readonly emittedAt: string
  /** A compact string over every rendered field, deliberately excluding `emittedAt`, so a poll that changed nothing never triggers a rebuild. */
  readonly signature: string
}
