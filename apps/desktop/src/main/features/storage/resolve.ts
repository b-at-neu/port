// `storage.report` — the Usage & storage tab's size read. Every path comes from main: the renderer never sends one.
import type { SizeRead, StorageEntry, StorageReport } from '@/types/settings'
import type { AppContext } from '@/main/app/context'
import { isReadyEntry } from '@/main/repos'
import { pathOps } from '@/main/platform/paths'

type StorageContext = Pick<AppContext, 'repos' | 'directorySize' | 'paths' | 'claudeHome'>

// A directory that does not exist holds nothing; any other failure is `Couldn't read`, never `0`.
async function readSize(ctx: StorageContext, path: string): Promise<SizeRead> {
  const result = await ctx.directorySize(path)
  if (result.ok) return { ok: true, bytes: result.bytes, truncated: result.truncated }
  if (result.kind === 'not-found') return { ok: true, bytes: 0, truncated: false }
  return { ok: false, message: result.message }
}

async function entryOf(ctx: StorageContext, label: string, path: string): Promise<StorageEntry> {
  return { label, path, size: await readSize(ctx, path) }
}

export async function readStorageReport(ctx: StorageContext): Promise<StorageReport> {
  const list = await ctx.repos.list()
  const ready = list.ok ? list.repositories.filter(isReadyEntry) : []
  const [appData, pluginCache, worktrees] = await Promise.all([
    Promise.all([entryOf(ctx, 'App data', ctx.paths.userData), entryOf(ctx, 'Logs', ctx.paths.logs)]),
    entryOf(ctx, 'Plugin cache', pathOps.join(ctx.claudeHome, 'plugins', 'cache')),
    Promise.all(
      ready.map(async (entry) => ({
        repoId: entry.id,
        ...(await entryOf(ctx, entry.config.repo, pathOps.join(entry.path, '.claude', 'worktrees'))),
      })),
    ),
  ])
  return { appData, pluginCache, worktrees }
}
