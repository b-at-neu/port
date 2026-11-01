// `'audit:list'`'s composition: validate the request, resolve the repository, then read the log.
import type { IpcMap } from '@/types/ipc'
import type { AuditRead } from '@/types/writes'
import { AUDIT_LIST_LIMIT } from '@/types/writes'
import { readAuditLog } from '@/main/writes/audit'
import { listRepositories, requireReadyRepo, requireRepoId } from '@/main/registry'
import type { RegistryDeps } from '@/types/registry'

export interface AuditListDeps {
  readonly listRepositories: typeof listRepositories
  readonly readAuditLog: typeof readAuditLog
}

export const defaultAuditListDeps: AuditListDeps = { listRepositories, readAuditLog }

// A non-null `repoId` must name a registered, `ready` repository; the slug is read from its own config, never the request.
export async function resolveAuditList(registryDeps: RegistryDeps, request: IpcMap['audit:list']['request'], auditDir: string, deps: AuditListDeps = defaultAuditListDeps): Promise<AuditRead> {
  const number = request?.number ?? null
  if (number !== null && (request.repoId === null || !Number.isSafeInteger(number) || number <= 0)) {
    throw new Error("'audit:list' requires a positive integer 'number' and a 'repoId' alongside it")
  }

  if (request.repoId === null) return deps.readAuditLog(auditDir, { limit: AUDIT_LIST_LIMIT })

  const repoId = requireRepoId(request.repoId, "'audit:list'")
  const entry = await requireReadyRepo(registryDeps, "'audit:list'", repoId, deps.listRepositories)

  return deps.readAuditLog(auditDir, { repo: entry.config.repo, ...(number === null ? {} : { number }), limit: AUDIT_LIST_LIMIT })
}
