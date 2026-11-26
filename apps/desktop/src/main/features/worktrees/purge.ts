// runPurge: deletes one confirmed orphan directory, and only when it is a member of this run's own orphan set.
import { readWorktrees } from '@/main/repos/local/worktrees'
import { pathOps } from '@/main/platform/paths'
import type { RunPurgeParams, WorktreesPurgeResult } from '@/types/reclaimer'
import { classifyRemovalFailure } from '@/main/features/worktrees/classify'
import { longpathsGit, type ReclaimContext } from '@/main/features/worktrees/inspect'
import { findOrphanDirs } from '@/main/features/worktrees/orphans'

export async function runPurge(ctx: Pick<ReclaimContext, 'git' | 'fs' | 'clock'>, params: RunPurgeParams): Promise<WorktreesPurgeResult> {
  const readAt = ctx.clock.now().toISOString()
  const call = ['purge', '--orphan', params.path]
  const pathBasename = pathOps.basename(params.path)

  const read = await readWorktrees({ git: longpathsGit(ctx.git), clock: ctx.clock, pathOps }, params.repoRoot)
  if (!read.ok) return { ok: false, kind: read.kind, message: read.message, readAt, call }

  const linked = read.entries.filter((entry) => !entry.isMain).map((entry) => ({ path: entry.path, isOutside: !entry.insideMain }))
  const orphans = await findOrphanDirs(ctx, read.mainPath, linked)
  if (!orphans.some((orphan) => pathOps.samePath(orphan, params.path))) {
    return { ok: true, outcome: 'refused', pathBasename, message: "not an orphan directory in this run's report; never deleted", cause: null, readAt, call }
  }

  const removal = await ctx.fs.removeDirectory(params.path)
  if (removal.ok) return { ok: true, outcome: 'deleted', pathBasename, message: null, cause: null, readAt, call }
  return { ok: true, outcome: 'failed', pathBasename, message: removal.message, cause: classifyRemovalFailure(removal.code), readAt, call }
}
