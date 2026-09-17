// Pure types and constants for the board projection (#80) — the first
// screen. No import here may reach a Node builtin or `src/main/`: the
// renderer is this ticket's own consumer, so this file compiles under
// `typecheck:web` exactly like the other `shared/` adapters it draws from.
import type { RepoId } from '../repos'
import type { ItemStatus, PipelineState, ReconciledItem, RepositoryState, StageLabel } from '../state/types'
import type { ActionAvailability, OperatorAction } from '../actions/types'

/**
 * The four sources the watcher polls independently. Deliberately not five:
 * `itemStates` is the dependent re-check `main/state/sources.ts`'s GitHub
 * primitive fires internally when the orphan set is non-empty, never an
 * independently schedulable source — `scripts/checks/desktop-board.mjs`
 * asserts every member here is a `RepositoryFreshness` key and that
 * `itemStates` is the only key that is not (ENGINEERING §2 pin).
 */
export const SOURCE_KINDS = ['github', 'sessions', 'worktrees', 'denials'] as const

export type SourceKind = (typeof SOURCE_KINDS)[number]

/** GitHub is the expensive one; the three local reads are cheap and can run
 *  far more often (the ticket's "Freshness" table). Named constants, shared
 *  by the scheduler and the staleness rule so the two can never disagree
 *  about what "one interval old" means. */
export const SOURCE_BASE_INTERVAL_MS: Readonly<Record<SourceKind, number>> = {
  github: 60_000,
  sessions: 15_000,
  worktrees: 15_000,
  denials: 15_000,
}

/** Backoff doubles from a source's base interval up to this ceiling. */
export const BACKOFF_CEILING_MS = 15 * 60 * 1000

/** Below this many points remaining, the GitHub source defers to the
 *  window's own `resetAt` instead of a doubled guess — a known reset instant
 *  always beats a guess. */
export const RATE_LIMIT_FLOOR = 200

/** Decision 5's suppression grace: a `stalled` verdict renders as `stalled`
 *  only when the GitHub read behind it is within `githubIntervalMs +
 *  STALE_GRACE_MS` — wide enough that ordinary poll jitter never triggers a
 *  false stall, narrow enough that a genuine stall is not hidden for long. */
export const STALE_GRACE_MS = 30_000

export interface SourceHealth {
  readonly lastSuccessAt: string | null
  readonly lastAttemptAt: string | null
  readonly consecutiveFailures: number
  readonly lastError: string | null
  /** The source's own current effective interval — base until a failure
   *  doubles it, reset to base on the next success (Decision 4). */
  readonly intervalMs: number
  /** Set only by a rate-limited GitHub failure — a known instant that
   *  overrides the doubled-interval guess entirely (`deferredUntil` in
   *  `schedule.ts`). */
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

/** One repository's own health across all four sources — `sessions` is the
 *  one machine-wide scan's health, copied onto every repository the same way
 *  `RepositoryFreshness.sessions` already is (Decision 5 in #79's plan). */
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

/** The one payload the watcher pushes and the renderer ever reads —
 *  `state` is #79's own `PipelineState`, unchanged; `health` and `policy`
 *  are this ticket's addition, carried alongside rather than folded in, so
 *  `PipelineState` stays #79's own shape. */
export interface BoardSnapshot {
  readonly state: PipelineState
  readonly health: readonly RepositoryHealth[]
  readonly policy: PollPolicy
  readonly emittedAt: string
}

export type GroupBy = 'stage' | 'repo'

/** Decision 5's own result — the only value it may ever change is `stalled`
 *  → `in-flight`, and it never rewrites `ReconciledItem.status` itself; this
 *  is a presentation verdict with its own name so the model and the screen
 *  can never silently disagree about what was observed. */
export interface DisplayStatus {
  readonly status: ItemStatus
  readonly staleGithub: boolean
  readonly githubAgeMs: number | null
}

export interface BoardItemRow {
  readonly item: ReconciledItem
  readonly displayStatus: DisplayStatus
  readonly stageLabel: StageLabel | null
  /** `actionsFor`'s own result for this item (#94) — every action, available
   *  or not, so the row can render its strip and its refusal note from one
   *  already-computed value, never a second derivation client-side. */
  readonly actions: Readonly<Record<OperatorAction, ActionAvailability>>
}

export interface BoardGroup {
  /** The label `key` (grouped by stage) or the `RepoId` (grouped by repo) —
   *  never a display name, so two repositories renaming the same label
   *  differently still group together (Data & contracts). */
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
  /** `null` only when the worktree source has never returned a good read for
   *  this repository — never `0` standing in for "did not run" (Decision 6). */
  readonly worktreeTotal: number | null
  /** #85's inspector's own burst copy, verbatim — `null` when no shape on
   *  this repository's denial log currently qualifies (Decision 7). Never a
   *  line total under the word "denials". */
  readonly denialBurst: string | null
}

export interface BoardProjection {
  readonly groupBy: GroupBy
  readonly groups: readonly BoardGroup[]
  readonly notReady: readonly Extract<RepositoryState, { readonly ok: false }>[]
  readonly repositorySummaries: readonly BoardRepositorySummary[]
  readonly totalItems: number
  /** Every row whose `gate` action is available, from a repository whose
   *  `approvalGate` module is on (#94) — a pipeline pull request carrying a
   *  stage label but not the marker, so CI cannot tell it from a human pull
   *  request. Never populated when the module is off: there is no gate to
   *  restore, so the section is absent entirely, not disabled. */
  readonly ungated: readonly BoardItemRow[]
  readonly emittedAt: string
  /** The Decision 1 no-op guard — a compact string over every rendered
   *  field, deliberately excluding `emittedAt` itself, so a poll that
   *  changed nothing never triggers a rebuild. */
  readonly signature: string
}
