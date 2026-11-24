import type { RecentsStore } from '@/types/workspace'

// `folders:list`/`folders:choose`/`session:changes`'s composition: registry read, the recents store, the native picker, and one session-workspace lookup — a channel composition root, never a second copy of `resolve.ts`'s logic.
import type { GitRunner } from '@/types/platform'
import { defaultGitRunner } from '@/main/platform/git'
import { pathOps as defaultPathOps } from '@/main/platform/paths'
import type { PathOps } from '@/types/platform'
import { statPath } from '@/main/platform/files'
import type { SessionKey } from '@/types/hosting'
import type { FolderEntry } from '@/types/workspace'
import type { SessionChanges, SessionWorkspace } from '@/types/workspace'
import { isReadyEntry, listRepositories } from '@/main/repos'
import type { RegistryDeps } from '@/types/registry'
import { chooseFolder as defaultChooseFolder } from '@/main/app/shell/dialogs'
import { toFolderEntry } from '@/main/repos/worktree/resolve'
import { computeSessionChanges as defaultComputeSessionChanges } from '@/main/repos/worktree/changes'

import { createRecentsStore, pruneMissing } from '@/main/features/folders/recents'

export interface WorkspaceChannelDeps {
  readonly listRepositories: typeof listRepositories
  readonly recents: RecentsStore
  readonly chooseFolder: () => Promise<string | null>
  readonly git: GitRunner
  readonly exists: (path: string) => Promise<boolean>
  readonly now: () => Date
  /** Resolves the live session's `SessionWorkspace` straight off its snapshot — `main/ipc.ts` wires
   *  this through `hostedStore.snapshotOf`. `null` is `unknown-session`. */
  readonly workspaceOf: (sessionKey: string) => Promise<SessionWorkspace | null>
  readonly computeSessionChanges: typeof defaultComputeSessionChanges
  readonly pathOps?: PathOps
}

async function defaultExists(path: string): Promise<boolean> {
  const result = await statPath(path)
  return result.ok
}

export function defaultWorkspaceChannelDeps(userDataDir: string, workspaceOf: WorkspaceChannelDeps['workspaceOf'], recents?: RecentsStore): WorkspaceChannelDeps {
  return {
    listRepositories,
    recents: recents ?? createRecentsStore({ dir: userDataDir }),
    chooseFolder: defaultChooseFolder,
    git: defaultGitRunner(),
    exists: defaultExists,
    now: () => new Date(),
    workspaceOf,
    computeSessionChanges: defaultComputeSessionChanges,
  }
}

export async function resolveFoldersList(registryDeps: RegistryDeps, request: undefined, deps: WorkspaceChannelDeps): Promise<{ readonly folders: readonly FolderEntry[] }> {
  if (request !== undefined) throw new Error("'folders:list' takes no payload")
  const ops = deps.pathOps ?? defaultPathOps

  const listed = await deps.listRepositories(registryDeps)
  const repositories = listed.ok ? listed.repositories : []
  const readyPaths = repositories.filter(isReadyEntry).map((entry) => entry.path)

  const registryFolders = await Promise.all(readyPaths.map((path) => toFolderEntry({ git: deps.git }, path, repositories, null)))

  const recents = await deps.recents.load()
  const live = await pruneMissing(recents, deps.exists)
  const newRecents = live.filter((recent) => !readyPaths.some((path) => ops.samePath(path, recent.path)))

  const recentFolders = await Promise.all(newRecents.map((recent) => toFolderEntry({ git: deps.git }, recent.path, repositories, recent.lastUsedAt)))

  const folders: readonly FolderEntry[] = [...registryFolders, ...recentFolders]
  return { folders }
}

export async function resolveFoldersChoose(
  registryDeps: RegistryDeps,
  request: undefined,
  deps: WorkspaceChannelDeps,
): Promise<{ readonly outcome: 'chosen'; readonly folder: FolderEntry } | { readonly outcome: 'cancelled' }> {
  if (request !== undefined) throw new Error("'folders:choose' takes no payload")

  const picked = await deps.chooseFolder()
  if (picked === null) return { outcome: 'cancelled' }

  const listed = await deps.listRepositories(registryDeps)
  const repositories = listed.ok ? listed.repositories : []
  const now = deps.now()

  await deps.recents.record(picked, now)
  const folder = await toFolderEntry({ git: deps.git }, picked, repositories, now.toISOString())
  return { outcome: 'chosen', folder }
}

export async function resolveSessionChanges(request: { readonly sessionKey: SessionKey }, deps: WorkspaceChannelDeps): Promise<SessionChanges> {
  if (typeof request?.sessionKey !== 'string' || request.sessionKey === '') {
    throw new Error("'session:changes' requires a non-empty 'sessionKey'")
  }
  const workspace = await deps.workspaceOf(request.sessionKey)
  if (workspace === null) return { ok: false, kind: 'unknown-session', message: `no session is open for key '${request.sessionKey}'` }
  return deps.computeSessionChanges({ git: deps.git, clock: { now: deps.now } }, workspace)
}
