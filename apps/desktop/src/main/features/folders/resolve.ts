import type { FolderEntry } from '@/types/workspace'
import type { Platform } from '@/main/platform'
import { pathOps } from '@/main/platform/paths'
import { isReadyEntry, type Repos } from '@/main/repos'
import type { AppContext } from '@/main/app/context'
import { toFolderEntry } from '@/main/repos/worktree/resolve'
import { pruneMissing } from '@/main/features/folders/recents'

type FoldersContext = { readonly repos: Pick<Repos, 'list'>; readonly stores: Pick<AppContext['stores'], 'recents'> }

export async function listFolders(ctx: Pick<Platform, 'git' | 'fs'> & FoldersContext): Promise<{ readonly folders: readonly FolderEntry[] }> {
  const listed = await ctx.repos.list()
  const repositories = listed.ok ? listed.repositories : []
  const readyPaths = repositories.filter(isReadyEntry).map((entry) => entry.path)

  const registryFolders = await Promise.all(readyPaths.map((path) => toFolderEntry(ctx, path, repositories, null)))

  const recents = await ctx.stores.recents.load()
  const live = await pruneMissing(recents, ctx.fs.exists)
  const newRecents = live.filter((recent) => !readyPaths.some((path) => pathOps.samePath(path, recent.path)))

  const recentFolders = await Promise.all(newRecents.map((recent) => toFolderEntry(ctx, recent.path, repositories, recent.lastUsedAt)))

  return { folders: [...registryFolders, ...recentFolders] }
}

export async function chooseFolder(ctx: Pick<Platform, 'git' | 'dialogs' | 'clock'> & FoldersContext): Promise<{ readonly outcome: 'chosen'; readonly folder: FolderEntry } | { readonly outcome: 'cancelled' }> {
  const picked = await ctx.dialogs.chooseFolder()
  if (picked === null) return { outcome: 'cancelled' }

  const listed = await ctx.repos.list()
  const repositories = listed.ok ? listed.repositories : []
  const now = ctx.clock.now()

  await ctx.stores.recents.record(picked, now)
  const folder = await toFolderEntry(ctx, picked, repositories, now.toISOString())
  return { outcome: 'chosen', folder }
}
