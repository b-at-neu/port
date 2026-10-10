// Pure decision logic for the New session dialog — folder ordering, preselection, and the
// worktree checkbox's forced/disabled/free state. No React, no IPC.
import type { RepoId } from '../../../shared/repos'
import type { FolderEntry, FolderId } from '../../../shared/workspace/types'
import type { HostedSessionSnapshot } from '../../../shared/hosting/types'

export type NewSessionPreselect = { readonly kind: 'repo'; readonly repoId: RepoId } | { readonly kind: 'path'; readonly path: string } | null

export interface OrderedFolders {
  readonly repos: readonly FolderEntry[]
  readonly recents: readonly FolderEntry[]
}

const RECENTS_CAP = 10

/** Registered repos first, then recents by `lastUsedAt` descending, capped at 10. */
export function orderFolders(folders: readonly FolderEntry[]): OrderedFolders {
  const repos = folders.filter((folder) => folder.repoId !== null)
  const recents = folders
    .filter((folder) => folder.repoId === null)
    .slice()
    .sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''))
    .slice(0, RECENTS_CAP)
  return { repos, recents }
}

/** Strips trailing separators on both sides and compares case-insensitively only when either
 *  side carries a Windows drive letter — a plain POSIX path still compares case-sensitively. */
export function samePathHint(a: string, b: string): boolean {
  const strip = (path: string) => path.replace(/[/\\]+$/, '')
  const left = strip(a)
  const right = strip(b)
  const hasDriveLetter = /^[A-Za-z]:/.test(left) || /^[A-Za-z]:/.test(right)
  return hasDriveLetter ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** The preselect match, else the latest `lastUsedAt`, else the first entry, else `null`. */
export function initialFolderId(folders: readonly FolderEntry[], preselect: NewSessionPreselect): FolderId | null {
  if (preselect?.kind === 'repo') {
    const found = folders.find((folder) => folder.repoId === preselect.repoId)
    if (found !== undefined) return found.id
  }
  if (preselect?.kind === 'path') {
    const found = folders.find((folder) => samePathHint(folder.path, preselect.path))
    if (found !== undefined) return found.id
  }
  if (folders.length === 0) return null
  const latest = folders.reduce<FolderEntry | null>((best, folder) => {
    if (folder.lastUsedAt === null) return best
    if (best === null || best.lastUsedAt === null) return folder
    return folder.lastUsedAt > best.lastUsedAt ? folder : best
  }, null)
  return (latest ?? folders[0] ?? null)?.id ?? null
}

export type WorktreeControl = { readonly kind: 'free' } | { readonly kind: 'forced-on'; readonly reason: string } | { readonly kind: 'disabled-off'; readonly reason: string }

const NOT_GIT_REASON = "This folder isn't a git repository."
const BUSY_REASON = 'Another session is already working in this folder.'

// `forced-on` when a live, non-`ended` snapshot has `workspace.worktree: null` at this folder's own path.
export function worktreeControl(folder: FolderEntry, snapshots: readonly HostedSessionSnapshot[]): WorktreeControl {
  if (folder.git === null) return { kind: 'disabled-off', reason: NOT_GIT_REASON }
  const busy = snapshots.some((snapshot) => snapshot.phase !== 'ended' && snapshot.workspace.worktree === null && samePathHint(snapshot.workspace.folder, folder.path))
  if (busy) return { kind: 'forced-on', reason: BUSY_REASON }
  return { kind: 'free' }
}

/** `free` defers to the user's own toggle, widened by a `folder-busy` result the main process
 *  reported after the renderer's own hint missed it. */
export function effectiveWorktree(control: WorktreeControl, userChecked: boolean, busyOverride: boolean): boolean {
  if (control.kind === 'forced-on') return true
  if (control.kind === 'disabled-off') return false
  return userChecked || busyOverride
}

/** "Branches from `<branch>` (`<sha>`) into its own folder." — a detached `HEAD` drops the branch clause. `null` for a non-git folder. */
export function worktreeHint(folder: FolderEntry): string | null {
  if (folder.git === null) return null
  const sha = folder.git.head.sha.slice(0, 7)
  const branch = folder.git.head.branch
  return branch !== null ? `Branches from ${branch} (${sha}) into its own folder.` : `Branches from ${sha} into its own folder.`
}
