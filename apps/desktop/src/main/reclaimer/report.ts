// readWorktreeReport: the read half of worktree hygiene, with item states resolved from GitHub.
import type { InspectedWorktree, ReadWorktreeReportParams, WorktreeState, WorktreesReport } from '@/types/reclaimer'
import { isReclaimableState } from '@/types/reclaimer'
import { inspectWorktrees, resolveSeams } from '@/main/reclaimer/inspect'

export async function readWorktreeReport(params: ReadWorktreeReportParams): Promise<WorktreesReport> {
  const { pathOps, now } = resolveSeams(params)
  const readAt = now().toISOString()

  const inspection = await inspectWorktrees({ ...params, unlock: false, forceDirty: false })
  if (!inspection.ok) return { ...inspection, readAt }

  const worktrees: InspectedWorktree[] = inspection.candidates.map((c) => ({
    path: c.entry.path,
    pathBasename: pathOps.basename(c.entry.path),
    branch: c.entry.branch,
    head: c.entry.head,
    state: c.state,
    reason: c.reason,
    issue: c.correlation?.number ?? null,
    rung: c.correlation?.rung ?? null,
    locked: c.entry.locked,
    lockReason: c.entry.lockReason,
    dirtyFiles: c.dirtyFiles,
    reclaimable: isReclaimableState(c.state),
    otherwiseReclaimable: c.otherwiseReclaimable,
    prunable: c.entry.prunable,
    producer: c.entry.producer,
  }))

  const byState: Partial<Record<WorktreeState, number>> = {}
  for (const worktree of worktrees) byState[worktree.state] = (byState[worktree.state] ?? 0) + 1

  return {
    ok: true,
    mainRoot: inspection.mainPath,
    integrationRef: inspection.integrationRef,
    worktrees,
    orphanDirs: inspection.orphanDirs,
    registered: worktrees.length,
    byState,
    githubResolution: inspection.githubError === null ? 'resolved' : 'unavailable',
    porcelainJoin: 'joined',
    readAt,
  }
}
