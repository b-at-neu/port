import type { GitRunner, NodeRunner, PathOps } from '@/types/platform'

// Renderer-safe shapes for the worktree inspector: driving the shipped worktrees script and joining the local read for the one fact its JSON omits (`prunable`). No import here may reach a Node builtin.
import type { CorrelationRung, WorktreeProducer } from '@/types/local'

/** Byte-for-byte `bin/worktrees.mjs`'s own state vocabulary. A `state` the app does not know is never widened to a string; `parse.ts` fails the whole payload with `report-unparseable` instead. */
export const WORKTREE_STATES = ['active', 'done', 'no-work', 'locked', 'dirty', 'outside', 'unresolved'] as const

export type WorktreeState = (typeof WORKTREE_STATES)[number]

/** The states `classifyCandidate` can report as `removable: true` — `reclaimable` is always derived from this list, never from parsing `reason` prose. */
export const RECLAIMABLE_STATES = ['done', 'no-work'] as const

export type ReclaimableState = (typeof RECLAIMABLE_STATES)[number]

export function isReclaimableState(state: WorktreeState): state is ReclaimableState {
  return (RECLAIMABLE_STATES as readonly string[]).includes(state)
}

/** One worktree row, joined from the script's `--json` payload and, when available, the local `readWorktrees`. `prunable`/`producer` are `null` only when that join failed. `reason` is the script's own sentence, passed through verbatim. */
export interface InspectedWorktree {
  readonly path: string
  /** Computed in `main/reclaimer/report.ts` — the renderer never manipulates a path itself, only displays the native string main resolved. */
  readonly pathBasename: string
  readonly branch: string | null
  readonly head: string | null
  readonly state: WorktreeState
  readonly reason: string
  readonly issue: number | null
  readonly rung: CorrelationRung | null
  readonly locked: boolean
  readonly lockReason: string | null
  readonly dirtyFiles: number
  readonly reclaimable: boolean
  /** Finished work (`done`/`no-work`) that only a lock or uncommitted changes keep from `reclaimable`. Always `false` from a script that predates `forcedActions`. */
  readonly otherwiseReclaimable: boolean
  readonly prunable: boolean | null
  readonly producer: WorktreeProducer | null
}

/** Every failure kind `readWorktreeReport` can report. The first five are this adapter's own, layered above the platform layer's `CommandResult` kinds. */
export type ReclaimerFailureKind =
  | 'not-configured'
  | 'unparseable-command'
  | 'unsupported-runner'
  | 'script-failed'
  | 'report-unparseable'
  | 'not-found'
  | 'cwd-missing'
  | 'nonzero'
  | 'signalled'
  | 'timeout'
  | 'output-too-large'
  | 'spawn-failed'

export type ReclaimerFailure =
  | { readonly kind: 'unsupported-runner'; readonly token: string; readonly message: string }
  | { readonly kind: Exclude<ReclaimerFailureKind, 'unsupported-runner'>; readonly message: string }

/** `'unavailable'` means a `nonzero` exit retried once with `--offline`. In that state a finished worktree reports `unresolved`, never `done` — the under-reporting is deliberate. */
export type GithubResolutionState = 'resolved' | 'unavailable'

/** `'unavailable'` means the local `readWorktrees` itself failed — `prunable`/`producer` are `null` on every row, and the report is still `ok: true`. */
export type PorcelainJoinState = 'joined' | 'unavailable'

/** `'unsupported'` means the installed script predates `--path`, so no forced reclaim or orphan delete is offered. */
export type ForcedActionsState = 'supported' | 'unsupported'

export type WorktreesReport =
  | {
      readonly ok: true
      readonly mainRoot: string
      readonly integrationRef: string
      readonly worktrees: readonly InspectedWorktree[]
      readonly orphanDirs: readonly string[]
      readonly registered: number
      readonly byState: Readonly<Partial<Record<WorktreeState, number>>>
      readonly githubResolution: GithubResolutionState
      readonly porcelainJoin: PorcelainJoinState
      readonly forcedActions: ForcedActionsState
      readonly readAt: string
    }
  | ({ readonly ok: false; readonly readAt: string } & ReclaimerFailure)

// One reclaimed candidate, off `reclaim --json`'s own `results` array.
// `error`/`branchDeleted` are populated only when `outcome` is not `'kept'`.
export interface ReclaimedWorktree {
  readonly path: string
  readonly pathBasename: string
  readonly issue: number | null
  readonly outcome: 'removed' | 'kept' | 'failed'
  readonly error: string | null
  readonly branchDeleted: boolean | null
}

// `runReclaim`'s own result — `ok: true` covers both a full and a partial
// success, with every candidate's own outcome in `results`.
export type WorktreesReclaimResult =
  | {
      readonly ok: true
      readonly removed: number
      readonly results: readonly ReclaimedWorktree[]
      readonly readAt: string
      /** The exact argv `runNode` spawned. */
      readonly call: readonly string[]
    }
  | ({ readonly ok: false; readonly readAt: string; readonly call: readonly string[] | null } & ReclaimerFailure)

/** The flags a forced reclaim passes. At least one is always true. */
export interface ForcedFlags {
  readonly unlock: boolean
  readonly forceDirty: boolean
}

/** One confirmed worktree and the flags the operator agreed to for it. */
export interface ForcedReclaim extends ForcedFlags {
  readonly path: string
}

export interface RunReclaimParams {
  readonly repoRoot: string
  /** `commands.worktrees` verbatim off the resolved config — `null` means
   *  the repository has not installed the reclamation script. */
  readonly worktreesCommand: string | null
  /** `null` reclaims every reclaimable candidate; a positive integer scopes
   *  the run to that ticket's own worktree (`--issue N`). */
  readonly issue: number | null
  /** Non-null scopes the run to that one path (`--path`) and passes the confirmed flags; never combined with `issue`. */
  readonly force: ForcedReclaim | null
  readonly runNode?: NodeRunner
  readonly now?: () => Date
  readonly pathOps?: PathOps
}

export type PurgeOutcome = 'deleted' | 'refused' | 'failed'

export type PurgeCause = 'file-in-use' | 'long-path' | 'unknown'

/** `runPurge`'s own result. A refused or failed outcome is still `ok: true`, since the script ran and said so. */
export type WorktreesPurgeResult =
  | {
      readonly ok: true
      readonly outcome: PurgeOutcome
      readonly pathBasename: string
      readonly message: string | null
      readonly cause: PurgeCause | null
      readonly readAt: string
      /** The exact argv `runNode` spawned. */
      readonly call: readonly string[]
    }
  | ({ readonly ok: false; readonly readAt: string; readonly call: readonly string[] | null } & ReclaimerFailure)

export interface RunPurgeParams {
  readonly repoRoot: string
  readonly worktreesCommand: string | null
  readonly path: string
  readonly runNode?: NodeRunner
  readonly now?: () => Date
  readonly pathOps?: PathOps
}

export interface ReadWorktreeReportParams {
  readonly repoRoot: string
  /** `null` means the repository has not installed the reclamation script. */
  readonly worktreesCommand: string | null
  readonly runNode?: NodeRunner
  /** Omitted means the join is skipped and `porcelainJoin` reports `'unavailable'` — the report
   *  itself still succeeds. */
  readonly git?: GitRunner
  readonly now?: () => Date
  readonly pathOps?: PathOps
}
