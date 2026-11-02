// runPurge: deletes one confirmed orphan directory, and only when it is a member of this run's own orphan set.
import { readWorktrees } from '@/main/local/worktrees'
import type { RunPurgeParams, WorktreesPurgeResult } from '@/types/reclaimer'
import { classifyRemovalFailure } from '@/main/reclaimer/classify'
import { resolveSeams } from '@/main/reclaimer/inspect'
import { findOrphanDirs } from '@/main/reclaimer/orphans'

export async function runPurge(params: RunPurgeParams): Promise<WorktreesPurgeResult> {
  const { git, fs, pathOps, now } = resolveSeams(params)
  const readAt = now().toISOString()
  const call = ['purge', '--orphan', params.path]
  const pathBasename = pathOps.basename(params.path)

  const read = await readWorktrees({ repoRoot: params.repoRoot, git, pathOps, now })
  if (!read.ok) return { ok: false, kind: read.kind, message: read.message, readAt, call }

  const linked = read.entries.filter((entry) => !entry.isMain).map((entry) => ({ path: entry.path, isOutside: !entry.insideMain }))
  const orphans = await findOrphanDirs(read.mainPath, linked, fs, pathOps)
  if (!orphans.some((orphan) => pathOps.samePath(orphan, params.path))) {
    return { ok: true, outcome: 'refused', pathBasename, message: "not an orphan directory in this run's report; never deleted", cause: null, readAt, call }
  }

  const removal = await fs.removeDirectory(params.path)
  if (removal.ok) return { ok: true, outcome: 'deleted', pathBasename, message: null, cause: null, readAt, call }
  return { ok: true, outcome: 'failed', pathBasename, message: removal.message, cause: classifyRemovalFailure(removal.code), readAt, call }
}
