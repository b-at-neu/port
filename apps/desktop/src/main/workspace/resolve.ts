// Resolves a folder/cwd to its `SessionWorkspace` and `repoId` — the registry's own path-key
// identity, never a second normalisation.
import { createHash } from 'node:crypto'
import type { GitRunner } from '../platform/git'
import { resolveGitBaseRoot } from '../platform/git'
import { pathOps as defaultPathOps } from '../platform/paths'
import type { PathOps } from '../platform/paths'
import type { RepoId, RepositoryEntry } from '../../shared/repos'
import type { FolderEntry, FolderId, SessionWorkspace } from '../../shared/workspace/types'
import { isReadyEntry } from '../registry'

function toFolderId(pathKey: string): FolderId {
  return `folder-${createHash('sha1').update(pathKey).digest('hex')}` as FolderId
}

/** Every call here goes through the injected `GitRunner`, never the module-level real `git` —
 *  `gitRepoRoot`'s own convenience wrapper isn't injectable, so root resolution is inlined. */
async function repoRootOf(git: GitRunner, folder: string, ops: PathOps): Promise<string | null> {
  const result = await git(['rev-parse', '--show-toplevel'], folder)
  if (!result.ok) return null
  const root = result.stdout.replace(/\r?\n$/, '')
  return root === '' ? null : ops.toNative(root)
}

async function currentBranch(git: GitRunner, cwd: string): Promise<string | null> {
  const result = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  if (!result.ok) return null
  const branch = result.stdout.trim()
  return branch === '' || branch === 'HEAD' ? null : branch
}

async function headSha(git: GitRunner, cwd: string): Promise<string | null> {
  const result = await git(['rev-parse', 'HEAD'], cwd)
  if (!result.ok) return null
  const sha = result.stdout.trim()
  return sha === '' ? null : sha
}

/** A linked worktree's `--git-dir` sits inside the common dir's own private-worktrees directory,
 *  so it never equals `--git-common-dir` the way the main checkout's does. */
async function isLinkedWorktree(git: GitRunner, cwd: string): Promise<boolean> {
  const [gitDirResult, commonDirResult] = await Promise.all([git(['rev-parse', '--git-dir'], cwd), git(['rev-parse', '--git-common-dir'], cwd)])
  if (!gitDirResult.ok || !commonDirResult.ok) return false
  return gitDirResult.stdout.trim() !== commonDirResult.stdout.trim()
}

async function portBaseOf(git: GitRunner, cwd: string, branch: string | null): Promise<{ sha: string; label: string } | null> {
  if (branch === null) return null
  const result = await git(['config', `branch.${branch}.portBase`], cwd)
  if (!result.ok) return null
  const sha = result.stdout.trim()
  return sha === '' ? null : { sha, label: branch }
}

export interface ResolveWorkspaceDeps {
  readonly git: GitRunner
  /** The ready, registered repositories to match the base root against — a snapshot the caller
   *  already has, never a second registry read inside this pure resolver. */
  readonly repositories: readonly RepositoryEntry[]
  readonly pathOps?: PathOps
}

/** Resolves one folder (a session's cwd) into its `SessionWorkspace` and `repoId`. Non-git folders
 *  resolve to `root: null`, no worktree, no `repoId`. */
export async function resolveWorkspace(folder: string, deps: ResolveWorkspaceDeps): Promise<{ readonly workspace: SessionWorkspace; readonly repoId: RepoId | null }> {
  const ops = deps.pathOps ?? defaultPathOps
  const root = await repoRootOf(deps.git, folder, ops)
  if (root === null) {
    return { workspace: { folder, root: null, worktree: null, base: null }, repoId: null }
  }

  const [linked, branch] = await Promise.all([isLinkedWorktree(deps.git, root), currentBranch(deps.git, root)])

  let worktree: SessionWorkspace['worktree'] = null
  let base: SessionWorkspace['base']

  if (linked && branch !== null) {
    worktree = { path: root, branch }
    base = await portBaseOf(deps.git, root, branch)
  } else {
    const sha = await headSha(deps.git, root)
    base = sha !== null ? { sha, label: branch ?? sha.slice(0, 7) } : null
  }

  const baseRoot = await resolveGitBaseRoot(deps.git, root, ops)
  const repoId = deps.repositories.find((entry) => isReadyEntry(entry) && ops.samePath(entry.path, baseRoot))?.id ?? null

  return { workspace: { folder, root, worktree, base }, repoId }
}

export interface ToFolderEntryDeps {
  readonly git: GitRunner
  readonly repositories: readonly RepositoryEntry[]
  readonly lastUsedAt: string | null
  readonly pathOps?: PathOps
}

/** Builds the `FolderEntry` the `folders:list`/`folders:choose` channels return for one path. */
export async function toFolderEntry(path: string, deps: ToFolderEntryDeps): Promise<FolderEntry> {
  const ops = deps.pathOps ?? defaultPathOps
  const key = ops.pathKey(path)
  const id = toFolderId(key)
  const name = ops.basename(path)

  const root = await repoRootOf(deps.git, path, ops)
  if (root === null) {
    return { id, path, name, git: null, repoId: null, lastUsedAt: deps.lastUsedAt }
  }

  const [sha, branch, baseRoot] = await Promise.all([headSha(deps.git, root), currentBranch(deps.git, root), resolveGitBaseRoot(deps.git, root, ops)])
  const repoId = deps.repositories.find((entry) => isReadyEntry(entry) && ops.samePath(entry.path, baseRoot))?.id ?? null

  return {
    id,
    path,
    name,
    git: sha !== null ? { root, head: { sha, branch } } : null,
    repoId,
    lastUsedAt: deps.lastUsedAt,
  }
}

export { toFolderId }
