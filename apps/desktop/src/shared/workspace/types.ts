// Renderer-safe workspace shapes — folders, session worktrees, and the Changes diff. No Node import here; `main/workspace/` derives these from real git state.
import type { RepoId } from '../repos'
import type { FileDiff } from '../sessions/transcript'

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
