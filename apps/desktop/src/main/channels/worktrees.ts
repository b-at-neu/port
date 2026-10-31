// The worktrees channels: `'worktrees:report'`'s read, and `'worktrees:reclaim'`'s composition —
// registry lookup, `runReclaim`, then exactly one `appendAudit` call, aborts included.
import type { IpcMap } from '@/types/ipc'
import type { ReclaimAuditEntry } from '@/types/writes'
import type { ReadWorktreeReportParams, ReclaimedWorktree, RunReclaimParams, WorktreesReclaimResult, WorktreesReport } from '@/types/reclaimer'
import { listRepositories, requireReadyRepo, requireRepoId } from '@/main/registry'
import type { RegistryDeps } from '@/types/registry'
import { runReclaim } from '@/main/reclaimer/reclaim'
import { readWorktreeReport } from '@/main/reclaimer/report'

import { appendAudit } from '@/main/writes/audit'

export interface WorktreesReportDeps {
  readonly listRepositories: typeof listRepositories
  readonly readWorktreeReport: (params: ReadWorktreeReportParams) => Promise<WorktreesReport>
}

const defaultWorktreesReportDeps: WorktreesReportDeps = { listRepositories, readWorktreeReport }

// The renderer sends only the opaque id, never a path.
export async function resolveWorktreesReport(
  registryDeps: RegistryDeps,
  request: IpcMap['worktrees:report']['request'],
  deps: WorktreesReportDeps = defaultWorktreesReportDeps,
): Promise<WorktreesReport> {
  if (typeof request?.id !== 'string' || request.id === '') {
    throw new Error("'worktrees:report' requires a non-empty 'id'")
  }
  const entry = await requireReadyRepo(registryDeps, "'worktrees:report'", request.id, deps.listRepositories)
  return deps.readWorktreeReport({
    repoRoot: entry.path,
    worktreesCommand: entry.config.commands.worktrees,
    git: registryDeps.git,
  })
}

export interface WorktreesReclaimDeps {
  readonly listRepositories: typeof listRepositories
  readonly runReclaim: (params: RunReclaimParams) => Promise<WorktreesReclaimResult>
  readonly appendAudit: typeof appendAudit
}

export const defaultWorktreesReclaimDeps: WorktreesReclaimDeps = { listRepositories, runReclaim, appendAudit }

function basenamesOf(results: readonly ReclaimedWorktree[], outcome: ReclaimedWorktree['outcome']): readonly string[] {
  return results.filter((r) => r.outcome === outcome).map((r) => r.pathBasename)
}

// `id` must name a registered, `ready` repository; `issue` is `null` or a
// positive integer. An audit failure never changes the already-computed result.
export async function resolveWorktreesReclaim(
  registryDeps: RegistryDeps,
  request: IpcMap['worktrees:reclaim']['request'],
  auditDir: string,
  deps: WorktreesReclaimDeps = defaultWorktreesReclaimDeps,
): Promise<WorktreesReclaimResult> {
  const repoId = requireRepoId(request?.id, "'worktrees:reclaim'")
  const issue: unknown = request.issue
  if (!(issue === null || (Number.isInteger(issue) && (issue as number) > 0))) {
    throw new Error("'worktrees:reclaim' requires 'issue' to be null or a positive integer")
  }

  const entry = await requireReadyRepo(registryDeps, "'worktrees:reclaim'", repoId, deps.listRepositories)

  const result = await deps.runReclaim({
    repoRoot: entry.path,
    worktreesCommand: entry.config.commands.worktrees,
    issue: request.issue,
  })

  const base = { at: new Date().toISOString(), repo: entry.config.repo, repoId, action: 'worktree-reclaim' as const, issue: request.issue }

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

  const audited = await deps.appendAudit(auditDir, auditEntry)
  if (!audited.ok) console.error(`'worktrees:reclaim' audit append failed: ${audited.message}`)

  return result
}
