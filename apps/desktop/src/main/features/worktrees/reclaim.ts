// runReclaim: the write half of report.ts's read. `--unlock`/`--force-dirty` apply only path-scoped to one confirmed worktree, never with an issue.
import type { InspectedCandidate, ReclaimedWorktree, RunReclaimParams, WorktreesReclaimResult } from '@/types/reclaimer'
import { pathOps } from '@/main/platform/paths'
import { inspectWorktrees, longpathsGit, type ReclaimContext } from '@/main/features/worktrees/inspect'
import { deleteMergedBranch, pruneWorktrees, removeWorktree, unlockWorktree } from '@/main/features/worktrees/remove'

const RECLAIM_MAX = 5

type Outcome = Pick<ReclaimedWorktree, 'outcome' | 'error' | 'branchDeleted'>

const KEPT: Outcome = { outcome: 'kept', error: null, branchDeleted: null }

function callOf(params: RunReclaimParams): readonly string[] {
  if (params.force !== null) {
    return ['reclaim', '--path', params.force.path, '--max', '1', ...(params.force.unlock ? ['--unlock'] : []), ...(params.force.forceDirty ? ['--force-dirty'] : [])]
  }
  return params.issue !== null ? ['reclaim', '--issue', String(params.issue)] : ['reclaim']
}

export async function runReclaim(ctx: ReclaimContext, params: RunReclaimParams): Promise<WorktreesReclaimResult> {
  const removal: ReclaimContext = { ...ctx, git: longpathsGit(ctx.git) }
  const readAt = ctx.clock.now().toISOString()
  const call = callOf(params)

  const inspection = await inspectWorktrees(ctx, { ...params, unlock: params.force?.unlock ?? false, forceDirty: params.force?.forceDirty ?? false })
  if (!inspection.ok) return { ...inspection, readAt, call }

  const scopeKey = params.force === null ? null : pathOps.pathKey(params.force.path)
  if (scopeKey !== null && !inspection.candidates.some((c) => pathOps.pathKey(c.entry.path) === scopeKey)) {
    return { ok: false, kind: 'path-not-registered', message: `${params.force?.path ?? ''} is not a registered worktree; nothing was touched.`, readAt, call: null }
  }
  // Without GitHub a finished worktree can't be told from an active one, so nothing is removed.
  if (inspection.githubError !== null) return { ok: false, kind: 'github-unavailable', message: inspection.githubError, readAt, call }

  const inScope = (c: InspectedCandidate): boolean =>
    c.removable && (params.issue === null || c.correlation?.number === params.issue) && (scopeKey === null || pathOps.pathKey(c.entry.path) === scopeKey)
  const max = params.force === null ? RECLAIM_MAX : 1

  const mtimes = new Map<string, number>()
  for (const c of inspection.candidates.filter(inScope)) {
    const stat = await ctx.fs.stat(c.entry.path)
    mtimes.set(c.entry.path, stat.ok ? Date.parse(stat.value.modifiedAt) : 0)
  }
  const queue = inspection.candidates.filter(inScope).sort((a, b) => (mtimes.get(a.entry.path) ?? 0) - (mtimes.get(b.entry.path) ?? 0))

  const outcomes = new Map<string, Outcome>()
  let removed = 0
  for (const c of queue) {
    if (removed >= max) break
    const { path, head, branch, locked } = c.entry

    if (locked && params.force?.unlock === true) {
      const unlocked = await unlockWorktree(removal, inspection.mainPath, path)
      if (!unlocked.ok) {
        outcomes.set(path, { outcome: 'failed', error: unlocked.message, branchDeleted: null })
        continue
      }
    }
    const result = await removeWorktree(removal, inspection.mainPath, { path, head })
    if (!result.removed) {
      outcomes.set(path, { outcome: 'failed', error: result.error, branchDeleted: null })
      continue
    }
    removed++
    const branchDeleted = branch === null ? null : await deleteMergedBranch(removal, inspection.mainPath, branch)
    outcomes.set(path, { outcome: 'removed', error: null, branchDeleted })
  }
  await pruneWorktrees(removal, inspection.mainPath)

  const results: ReclaimedWorktree[] = inspection.candidates.map((c) => ({
    path: c.entry.path,
    pathBasename: pathOps.basename(c.entry.path),
    issue: c.correlation?.number ?? null,
    ...(outcomes.get(c.entry.path) ?? KEPT),
  }))
  return { ok: true, removed, results, readAt, call }
}
