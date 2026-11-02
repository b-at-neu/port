// The only file here that names `git worktree remove`, `unlock` or `prune`.
import { readWorktrees } from '@/main/local/worktrees'
import type { CommandResult } from '@/types/platform'
import type { PurgeCause, ResolvedSeams } from '@/types/reclaimer'
import { classifyRemovalFailure, fallbackDecision } from '@/main/reclaimer/classify'

export interface RemovalOutcome {
  readonly removed: boolean
  readonly error: string | null
  readonly cause: PurgeCause | null
}

function failureText(result: Exclude<CommandResult, { ok: true }>): string {
  if ('stderr' in result && result.stderr.trim() !== '') return result.stderr.trim().split('\n')[0] ?? result.kind
  return result.kind === 'spawn-failed' ? result.message : result.kind
}

export async function unlockWorktree(seams: ResolvedSeams, mainPath: string, path: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
  const result = await seams.git(['worktree', 'unlock', path], mainPath)
  return result.ok ? { ok: true } : { ok: false, message: `unlock failed: ${failureText(result)}` }
}

/** `git worktree remove`, then the filesystem when git left the directory behind. A failed re-list keeps the directory. */
export async function removeWorktree(seams: ResolvedSeams, mainPath: string, candidate: { readonly path: string; readonly head: string | null }): Promise<RemovalOutcome> {
  await seams.git(['worktree', 'remove', '--force', candidate.path], mainPath)

  const dirExists = await seams.fs.pathExists(candidate.path)
  const relist = await readWorktrees({ repoRoot: mainPath, git: seams.git, pathOps: seams.pathOps, now: seams.now })
  if (!relist.ok && dirExists) {
    return { removed: false, error: "couldn't re-read the worktree list after removal; not deleted.", cause: null }
  }
  const match = relist.ok ? relist.entries.find((entry) => seams.pathOps.samePath(entry.path, candidate.path)) : undefined

  const decision = fallbackDecision({ dirExists, stillRegistered: match !== undefined, headNow: match?.head ?? null, headClassified: candidate.head })
  if (decision.action === 'done') return { removed: true, error: null, cause: null }
  if (decision.action === 'abort') return { removed: false, error: 'HEAD moved while it was being removed; not deleted.', cause: null }

  const removal = await seams.fs.removeDirectory(candidate.path)
  if (removal.ok) return { removed: true, error: null, cause: null }
  return { removed: false, error: removal.message, cause: classifyRemovalFailure(removal.code) }
}

/** `branch -d`, never `-D`: an unmerged branch is kept and says why. */
export async function deleteMergedBranch(seams: ResolvedSeams, mainPath: string, branch: string): Promise<boolean> {
  const result = await seams.git(['branch', '-d', branch], mainPath)
  return result.ok
}

export async function pruneWorktrees(seams: ResolvedSeams, mainPath: string): Promise<void> {
  await seams.git(['worktree', 'prune'], mainPath)
}
