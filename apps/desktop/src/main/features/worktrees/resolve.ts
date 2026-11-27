// The worktrees channels: `'worktrees:report'`'s read, and the `'worktrees:reclaim'` and
// `'worktrees:purge'` compositions — registry lookup, the run, then exactly one `appendAudit` call.
import type { RepoId } from '@/utils/repos'
import type { PurgeAuditEntry, ReclaimAuditEntry } from '@/types/writes'
import type { ForcedReclaim, ReclaimedWorktree, WorktreesPurgeResult, WorktreesReclaimResult, WorktreesReport } from '@/types/reclaimer'
import type { AppContext } from '@/main/app/context'
import { readyEntryOf } from '@/main/pipeline/context'
import { pathOps } from '@/main/platform/paths'
import { runPurge } from '@/main/features/worktrees/purge'
import { runReclaim } from '@/main/features/worktrees/reclaim'
import { readWorktreeReport } from '@/main/features/worktrees/report'
import { appendAudit } from '@/main/github/writes/audit'

export type WorktreesContext = Pick<AppContext, 'repos' | 'paths' | 'git' | 'fs' | 'clock' | 'tracker'>

const unlistable = (subject: string) => (message: string) => `${subject} could not list repositories: ${message}`

function basenamesOf(results: readonly ReclaimedWorktree[], outcome: ReclaimedWorktree['outcome']): readonly string[] {
  return results.filter((r) => r.outcome === outcome).map((r) => r.pathBasename)
}

function requireContainedPath(value: string, root: string, channel: string, field: string): string {
  if (!pathOps.contains(root, value)) throw new Error(`'${channel}' requires '${field}' to be inside the repository`)
  return value
}

export async function readWorktreesReport(ctx: WorktreesContext, request: { readonly id: RepoId }): Promise<WorktreesReport> {
  const entry = await readyEntryOf(ctx, "'worktrees:report'", request.id, unlistable("'worktrees:report'"))
  return readWorktreeReport(ctx, { repoRoot: entry.path, repo: entry.config.repo, integration: entry.config.branches.integration })
}

// `force` is `null` or one path inside the repository, never combined with `issue`; an audit
// failure never changes the already-computed result.
export async function reclaimWorktrees(
  ctx: WorktreesContext,
  request: { readonly id: RepoId; readonly issue: number | null; readonly force: ForcedReclaim | null },
): Promise<WorktreesReclaimResult> {
  const { force } = request
  const entry = await readyEntryOf(ctx, "'worktrees:reclaim'", request.id, unlistable("'worktrees:reclaim'"))
  if (force !== null) requireContainedPath(force.path, entry.path, 'worktrees:reclaim', 'force.path')

  const result = await runReclaim(ctx, {
    repoRoot: entry.path,
    repo: entry.config.repo,
    integration: entry.config.branches.integration,
    issue: request.issue,
    force,
  })

  const base = {
    at: ctx.clock.now().toISOString(),
    repo: entry.config.repo,
    repoId: request.id,
    action: 'worktree-reclaim' as const,
    issue: request.issue,
    force: force === null ? null : { unlock: force.unlock, forceDirty: force.forceDirty },
  }

  const auditEntry: ReclaimAuditEntry = result.ok
    ? {
        ...base,
        call: result.call,
        removed: basenamesOf(result.results, 'removed'),
        failed: basenamesOf(result.results, 'failed'),
        result: result.results.some((r) => r.outcome === 'failed') ? 'partial' : 'applied',
        failure: null,
      }
    : { ...base, call: result.call, removed: [], failed: [], result: 'failed', failure: result.kind }

  const audited = await appendAudit(ctx.paths.userData, auditEntry)
  if (!audited.ok) console.error(`'worktrees:reclaim' audit append failed: ${audited.message}`)

  return result
}

// `path` must sit inside the registered repository; the purge refuses anything that is not an orphan.
export async function purgeWorktree(ctx: WorktreesContext, request: { readonly id: RepoId; readonly path: string }): Promise<WorktreesPurgeResult> {
  const entry = await readyEntryOf(ctx, "'worktrees:purge'", request.id, unlistable("'worktrees:purge'"))
  const path = requireContainedPath(request.path, entry.path, 'worktrees:purge', 'path')

  const result = await runPurge(ctx, { repoRoot: entry.path, path })

  const base = { at: ctx.clock.now().toISOString(), repo: entry.config.repo, repoId: request.id, action: 'worktree-purge' as const, path: pathOps.basename(path) }
  const auditEntry: PurgeAuditEntry = result.ok
    ? { ...base, call: result.call, result: result.outcome, failure: null }
    : { ...base, call: result.call, result: 'failed', failure: result.kind }

  const audited = await appendAudit(ctx.paths.userData, auditEntry)
  if (!audited.ok) console.error(`'worktrees:purge' audit append failed: ${audited.message}`)

  return result
}
