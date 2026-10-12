import type { GitRunner, PathOps } from '@/types/platform'
import type { SessionReader } from '@/types/sessions'
import type { SessionStartResult } from '@/types/hosting'
import type { RepositoryEntry } from '@/utils/repos'

// Renderer-safe workspace shapes — folders, session worktrees, and the Changes diff. No Node import here; `main/workspace/` derives these from real git state.
import type { RepoId } from '@/utils/repos'
import type { FileDiff } from '@/utils/sessions/transcript'

export interface RecentFolder {
  readonly path: string
  readonly lastUsedAt: string
}

declare const folderIdBrand: unique symbol

/** Branded string minted only by main from a path-key normalisation — a raw path cannot be passed where a `FolderId` is expected. */
export type FolderId = string & { readonly [folderIdBrand]: true }

/** One folder the renderer can choose or has used before. `git` is `null` for a non-git folder. */
export interface FolderEntry {
  readonly id: FolderId
  readonly path: string
  readonly name: string
  readonly git: { readonly root: string; readonly head: { readonly sha: string; readonly branch: string | null } } | null
  readonly repoId: RepoId | null
  readonly lastUsedAt: string | null
}

/** A session's resolved folder, worktree (if any), and diff base. `root: null` means the folder is not inside a git repository — no worktree, no changes. */
export interface SessionWorkspace {
  readonly folder: string
  readonly root: string | null
  readonly worktree: { readonly path: string; readonly branch: string } | null
  readonly base: { readonly sha: string; readonly label: string } | null
}

export type SessionChangesFailureKind = 'unknown-session' | 'not-git' | 'base-missing' | 'folder-missing' | 'git-failed'

/** `session:changes`'s response. `truncated` means the full diff exceeded the byte cap — `files` is empty and `summary` carries numstat counts instead. */
export type SessionChanges =
  | {
      readonly ok: true
      readonly base: { readonly sha: string; readonly label: string } | null
      readonly files: readonly FileDiff[]
      readonly untracked: readonly string[]
      readonly binary: readonly string[]
      readonly summary: readonly { readonly path: string; readonly additions: number; readonly deletions: number }[]
      readonly truncated: boolean
      readonly readAt: string
    }
  | { readonly ok: false; readonly kind: SessionChangesFailureKind; readonly message: string }

export interface RecentsStore {
  /** Missing, unparseable, wrong-shaped, or newer-versioned all resolve to an empty list. */
  load(): Promise<readonly RecentFolder[]>
  /** Upserts by `samePath` (moving the match to most-recent), then caps at `RECENTS_CAP`. */
  record(path: string, now: Date): Promise<void>
}

export interface ResolveStartTargetDeps {
  readonly git: GitRunner
  readonly repositories: readonly RepositoryEntry[]
  readonly recents: RecentsStore
  readonly exists: (path: string) => Promise<boolean>
  readonly readSessions: SessionReader
  readonly createWorktree: (params: CreateSessionWorktreeParams) => Promise<CreateSessionWorktreeResult>
  readonly pathOps?: PathOps
}

export type ResolvedStartTarget =
  | {
      readonly ok: true
      readonly cwd: string
      readonly workspace: SessionWorkspace
      readonly repoId: RepoId | null
      /** The worktree this resolution created, so a failed `store.start` can remove it again. */
      readonly createdWorktree: { readonly path: string } | null
      /** The folder path to record in recents on a successful start — `null` for a transcript target. */
      readonly recordPath: string | null
    }
  | Exclude<SessionStartResult, { readonly ok: true } | { readonly ok: false; readonly kind: 'at-capacity' | 'runtime' | 'already-open' | 'folder-busy' }>

export type RemoveSessionWorktreeOutcome = { readonly outcome: 'removed' } | { readonly outcome: 'dirty' } | { readonly outcome: 'failed'; readonly message: string }

export interface CreateSessionWorktreeParams {
  readonly root: string
  readonly git: GitRunner
  /** Injectable so a collision-retry path is exercised deterministically in tests. */
  readonly random?: () => string
  readonly pathOps?: PathOps
}

export type CreateSessionWorktreeResult = { readonly ok: true; readonly path: string; readonly branch: string; readonly baseSha: string } | { readonly ok: false; readonly message: string }
