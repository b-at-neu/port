// The worktrees channels: `'worktrees:report'`'s read, and the `'worktrees:reclaim'` and
// `'worktrees:purge'` compositions — registry lookup, the run, then exactly one `appendAudit` call.
import type { IpcMap } from '@/types/ipc'
import type { PurgeAuditEntry, ReclaimAuditEntry } from '@/types/writes'
import type {
  ForcedReclaim,
  ReclaimedWorktree,
  RunPurgeParams,
  RunReclaimParams,
  WorktreesPurgeResult,
  WorktreesReclaimResult,
  WorktreesReport,
} from '@/types/reclaimer'
import type { WorktreesReportDeps } from '@/types/channels'
import { listRepositories, requireReadyRepo, requireRepoId } from '@/main/registry'
import type { RegistryDeps } from '@/types/registry'
import { isRecord } from '@/main/guards'
import { pathOps } from '@/main/platform/paths'
import { runPurge } from '@/main/reclaimer/purge'
import { runReclaim } from '@/main/reclaimer/reclaim'
import { readWorktreeReport } from '@/main/reclaimer/report'

import { appendAudit } from '@/main/writes/audit'

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

function requireContainedPath(value: unknown, root: string, channel: string, field: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`'${channel}' requires '${field}' to be a non-empty string`)
  if (!pathOps.contains(root, value)) throw new Error(`'${channel}' requires '${field}' to be inside the repository`)
  return value
}

function readForce(raw: unknown): ForcedReclaim | null {
  if (raw === null) return null
  const force = raw
  if (!isRecord(force) || typeof force.path !== 'string' || force.path === '') {
    throw new Error("'worktrees:reclaim' requires 'force' to be null or carry a non-empty 'path'")
  }
  if (typeof force.unlock !== 'boolean' || typeof force.forceDirty !== 'boolean') {
    throw new Error("'worktrees:reclaim' requires 'force.unlock' and 'force.forceDirty' to be booleans")
  }
  if (!force.unlock && !force.forceDirty) throw new Error("'worktrees:reclaim' requires 'force' to set at least one flag")
  return { path: force.path, unlock: force.unlock, forceDirty: force.forceDirty }
}

// `force` is `null` or one path inside the repository, never combined with `issue`; an audit
// failure never changes the already-computed result.
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
  const force = readForce(request.force)
  if (force !== null && issue !== null) throw new Error("'worktrees:reclaim' requires 'issue' to be null when 'force' is set")

  const entry = await requireReadyRepo(registryDeps, "'worktrees:reclaim'", repoId, deps.listRepositories)
  if (force !== null) requireContainedPath(force.path, entry.path, 'worktrees:reclaim', 'force.path')

  const result = await deps.runReclaim({
    repoRoot: entry.path,
    worktreesCommand: entry.config.commands.worktrees,
    issue: request.issue,
    force,
  })

  const base = {
    at: new Date().toISOString(),
    repo: entry.config.repo,
    repoId,
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

  const audited = await deps.appendAudit(auditDir, auditEntry)
  if (!audited.ok) console.error(`'worktrees:reclaim' audit append failed: ${audited.message}`)

  return result
}

export interface WorktreesPurgeDeps {
  readonly listRepositories: typeof listRepositories
  readonly runPurge: (params: RunPurgeParams) => Promise<WorktreesPurgeResult>
  readonly appendAudit: typeof appendAudit
}

export const defaultWorktreesPurgeDeps: WorktreesPurgeDeps = { listRepositories, runPurge, appendAudit }

// `path` must sit inside the registered repository; the script refuses anything that is not an orphan.
export async function resolveWorktreesPurge(
  registryDeps: RegistryDeps,
  request: IpcMap['worktrees:purge']['request'],
  auditDir: string,
  deps: WorktreesPurgeDeps = defaultWorktreesPurgeDeps,
): Promise<WorktreesPurgeResult> {
  const repoId = requireRepoId(request?.id, "'worktrees:purge'")
  const entry = await requireReadyRepo(registryDeps, "'worktrees:purge'", repoId, deps.listRepositories)
  const path = requireContainedPath(request.path, entry.path, 'worktrees:purge', 'path')

  const result = await deps.runPurge({ repoRoot: entry.path, worktreesCommand: entry.config.commands.worktrees, path })

  const base = { at: new Date().toISOString(), repo: entry.config.repo, repoId, action: 'worktree-purge' as const, path: pathOps.basename(path) }
  const auditEntry: PurgeAuditEntry = result.ok
    ? { ...base, call: result.call, result: result.outcome, failure: null }
    : { ...base, call: result.call, result: 'failed', failure: result.kind }

  const audited = await deps.appendAudit(auditDir, auditEntry)
  if (!audited.ok) console.error(`'worktrees:purge' audit append failed: ${audited.message}`)

  return result
}
