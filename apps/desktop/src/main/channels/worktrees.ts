// `'worktrees:reclaim'`'s composition: registry lookup, `runReclaim`, then
// exactly one `appendAudit` call — aborts included.
import type { IpcMap } from '../../shared/ipc'
import type { ReclaimAuditEntry } from '../../shared/writes/types'
import type { ReclaimedWorktree, WorktreesReclaimResult } from '../../shared/reclaimer/types'
import { listRepositories, requireReadyRepo, requireRepoId } from '../registry'
import type { RegistryDeps } from '../registry'
import { runReclaim } from '../reclaimer/reclaim'
import type { RunReclaimParams } from '../reclaimer/reclaim'
import { appendAudit } from '../writes/audit'

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
