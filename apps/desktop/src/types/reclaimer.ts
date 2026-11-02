// Renderer-safe shapes for the worktree inspector: the in-process classification and the local read's `prunable`/`producer` join. No import here may reach a Node builtin.
import type { DirEntry, FileResult, GhRunner, GitRunner, PathOps, RemoveDirectoryResult, StatInfo } from '@/types/platform'
import type { CorrelationRung, WorktreeCorrelation, WorktreeEntry, WorktreeProducer } from '@/types/local'
import type { ItemStateName } from '@/types/github'

/** Byte-for-byte `bin/worktrees.mjs`'s own state vocabulary, pinned by `desktop-reclaimer`. */
export const WORKTREE_STATES = ['active', 'done', 'no-work', 'locked', 'dirty', 'outside', 'unresolved'] as const

export type WorktreeState = (typeof WORKTREE_STATES)[number]

/** The states `classifyCandidate` can report as `removable: true` — `reclaimable` is always derived from this list, never from parsing `reason` prose. */
export const RECLAIMABLE_STATES = ['done', 'no-work'] as const

export type ReclaimableState = (typeof RECLAIMABLE_STATES)[number]

export function isReclaimableState(state: WorktreeState): state is ReclaimableState {
  return (RECLAIMABLE_STATES as readonly string[]).includes(state)
}

/** One worktree row. `prunable`/`producer` are `null` only when the local read's join failed. */
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
  /** Finished work (`done`/`no-work`) that only a lock or uncommitted changes keep from `reclaimable`. */
  readonly otherwiseReclaimable: boolean
  readonly prunable: boolean | null
  readonly producer: WorktreeProducer | null
}

/** Every failure kind a reclaimer read can report. The last four are this module's own, layered above git's `CommandResult` kinds. */
export type ReclaimerFailureKind =
  | 'not-found'
  | 'cwd-missing'
  | 'nonzero'
  | 'signalled'
  | 'timeout'
  | 'output-too-large'
  | 'spawn-failed'
  | 'not-a-repository'
  | 'no-integration-ref'
  | 'path-not-registered'
  | 'github-unavailable'

export type ReclaimerFailure =
  | { readonly kind: 'no-integration-ref'; readonly message: string; readonly integration: string }
  | { readonly kind: Exclude<ReclaimerFailureKind, 'no-integration-ref'>; readonly message: string }

/** `'unavailable'` means GitHub could not be read. In that state a correlated worktree reports `unresolved`, never `done` — the under-reporting is deliberate. */
export type GithubResolutionState = 'resolved' | 'unavailable'

/** `'unavailable'` means the local `readWorktrees` join was skipped — `prunable`/`producer` are `null` on every row, and the report is still `ok: true`. */
export type PorcelainJoinState = 'joined' | 'unavailable'

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
      readonly readAt: string
    }
  | ({ readonly ok: false; readonly readAt: string } & ReclaimerFailure)

// One reclaimed candidate. `error`/`branchDeleted` are populated only when `outcome` is not `'kept'`.
export interface ReclaimedWorktree {
  readonly path: string
  readonly pathBasename: string
  readonly issue: number | null
  readonly outcome: 'removed' | 'kept' | 'failed'
  readonly error: string | null
  readonly branchDeleted: boolean | null
}

// `ok: true` covers both a full and a partial success, with every candidate's own outcome in `results`.
export type WorktreesReclaimResult =
  | {
      readonly ok: true
      readonly removed: number
      readonly results: readonly ReclaimedWorktree[]
      readonly readAt: string
      /** The logical argv this run stands for, e.g. `['reclaim', '--issue', '36']`. */
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

export type PurgeOutcome = 'deleted' | 'refused' | 'failed'

export type PurgeCause = 'file-in-use' | 'long-path' | 'unknown'

/** A refused or failed outcome is still `ok: true`, since the run happened and said so. */
export type WorktreesPurgeResult =
  | {
      readonly ok: true
      readonly outcome: PurgeOutcome
      readonly pathBasename: string
      readonly message: string | null
      readonly cause: PurgeCause | null
      readonly readAt: string
      /** The logical argv this run stands for, e.g. `['purge', '--orphan', path]`. */
      readonly call: readonly string[]
    }
  | ({ readonly ok: false; readonly readAt: string; readonly call: readonly string[] | null } & ReclaimerFailure)

/** What `orphanVerdict` needs to know about a directory's own `.git` entry. */
export interface OrphanInput {
  readonly gitEntry: 'dir' | 'file' | 'none' | 'unreadable'
  readonly gitdirTargetExists: boolean
}

/** One linked worktree after classification — what `report`, `reclaim` and `purge` all read. */
export interface InspectedCandidate {
  readonly entry: WorktreeEntry
  /** Correlation is `null` for an outside entry, whatever its name says. */
  readonly correlation: WorktreeCorrelation | null
  readonly itemState: ItemStateName | null
  /** `-1` means `git status` itself failed, counted as dirty. */
  readonly dirtyFiles: number
  readonly state: WorktreeState
  readonly removable: boolean
  readonly otherwiseReclaimable: boolean
  readonly reason: string
}

export type Inspection =
  | {
      readonly ok: true
      readonly mainPath: string
      readonly integrationRef: string
      readonly candidates: readonly InspectedCandidate[]
      readonly orphanDirs: readonly string[]
      /** `null` when every state was read; otherwise why GitHub could not be, with every item state unknown. */
      readonly githubError: string | null
    }
  | ({ readonly ok: false } & ReclaimerFailure)

/** The filesystem calls the reclaimer makes, injected so a test never touches a disk. */
export interface ReclaimerFs {
  listDirectory(path: string): Promise<FileResult<readonly DirEntry[]>>
  statPath(path: string): Promise<FileResult<StatInfo>>
  readTextFile(path: string): Promise<FileResult<string>>
  pathExists(path: string): Promise<boolean>
  removeDirectory(path: string): Promise<RemoveDirectoryResult>
}

/** Seams every reclaimer entry point takes; each defaults to its production implementation. */
export interface ReclaimerSeams {
  readonly git?: GitRunner
  readonly fs?: ReclaimerFs
  readonly now?: () => Date
  readonly pathOps?: PathOps
}

/** `ReclaimerSeams` with every default filled in. */
export interface ResolvedSeams {
  readonly git: GitRunner
  readonly fs: ReclaimerFs
  readonly pathOps: PathOps
  readonly now: () => Date
}

export interface ReadWorktreeReportParams extends ReclaimerSeams {
  readonly repoRoot: string
  /** `owner/name` off the effective config. */
  readonly repo: string
  /** The effective integration branch, not the checked-out config's. */
  readonly integration: string
  readonly gh?: GhRunner
}

export interface RunReclaimParams extends ReadWorktreeReportParams {
  /** `null` reclaims every reclaimable candidate; a positive integer scopes the run to that ticket's own worktree. */
  readonly issue: number | null
  /** Non-null scopes the run to that one path and passes the confirmed flags; never combined with `issue`. */
  readonly force: ForcedReclaim | null
}

export interface RunPurgeParams extends ReclaimerSeams {
  readonly repoRoot: string
  readonly path: string
}
