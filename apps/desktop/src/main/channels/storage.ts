// `storage:report` and `usage:summary` — the Usage & storage tab's two reads. Neither takes a payload,
// and every path comes from main: the renderer never sends one.
import type { IpcMap } from '@/types/ipc'
import type { DirectorySizeResult } from '@/types/platform'
import type { RegistryDeps } from '@/types/registry'
import type { SizeRead, StorageEntry, StorageReport, UsageLedger, UsageSummary } from '@/types/settings'
import { isReadyEntry, listRepositories } from '@/main/registry'
import { pathOps } from '@/main/platform/paths'

export interface StorageReportDeps {
  readonly listRepositories: typeof listRepositories
  readonly directorySize: (path: string) => Promise<DirectorySizeResult>
  readonly userData: string
  readonly logs: string
  readonly claudeHome: () => string
}

// A directory that does not exist holds nothing; any other failure is `Couldn't read`, never `0`.
async function readSize(deps: StorageReportDeps, path: string): Promise<SizeRead> {
  const result = await deps.directorySize(path)
  if (result.ok) return { ok: true, bytes: result.bytes, truncated: result.truncated }
  if (result.kind === 'not-found') return { ok: true, bytes: 0, truncated: false }
  return { ok: false, message: result.message }
}

async function entryOf(deps: StorageReportDeps, label: string, path: string): Promise<StorageEntry> {
  return { label, path, size: await readSize(deps, path) }
}

export async function resolveStorageReport(registryDeps: RegistryDeps, request: IpcMap['storage:report']['request'], deps: StorageReportDeps): Promise<StorageReport> {
  if (request !== undefined) throw new Error("'storage:report' takes no payload")
  const list = await deps.listRepositories(registryDeps)
  const ready = list.ok ? list.repositories.filter(isReadyEntry) : []
  const [appData, pluginCache, worktrees] = await Promise.all([
    Promise.all([entryOf(deps, 'App data', deps.userData), entryOf(deps, 'Logs', deps.logs)]),
    entryOf(deps, 'Plugin cache', pathOps.join(deps.claudeHome(), 'plugins', 'cache')),
    Promise.all(
      ready.map(async (entry) => ({
        repoId: entry.id,
        ...(await entryOf(deps, entry.config.repo, pathOps.join(entry.path, '.claude', 'worktrees'))),
      })),
    ),
  ])
  return { appData, pluginCache, worktrees }
}

export function resolveUsageSummary(request: IpcMap['usage:summary']['request'], ledger: UsageLedger): UsageSummary {
  if (request !== undefined) throw new Error("'usage:summary' takes no payload")
  return ledger.summary()
}
