// `folders:list`/`folders:choose`/`session:changes`'s composition: registry read, the recents store, the native picker, and one session-workspace lookup — a channel composition root, never a second copy of `resolve.ts`'s logic.
import type { GitRunner } from '../platform/git'
import { defaultGitRunner } from '../platform/git'
import { pathOps as defaultPathOps } from '../platform/paths'
import type { PathOps } from '../platform/paths'
import { statPath } from '../platform/files'
import type { IpcMap } from '../../shared/ipc'
import type { FolderEntry } from '../../shared/workspace/types'
import type { SessionChanges, SessionWorkspace } from '../../shared/workspace/types'
import { isReadyEntry, listRepositories } from '../registry'
import type { RegistryDeps } from '../registry'
import { chooseFolder as defaultChooseFolder } from '../dialogs'
import { toFolderEntry } from '../workspace/resolve'
import { computeSessionChanges as defaultComputeSessionChanges } from '../workspace/changes'
import type { RecentsStore } from '../workspace/recents'
import { createRecentsStore, pruneMissing } from '../workspace/recents'

export interface WorkspaceChannelDeps {
  readonly listRepositories: typeof listRepositories
  readonly recents: RecentsStore
  readonly chooseFolder: () => Promise<string | null>
  readonly git: GitRunner
  readonly exists: (path: string) => Promise<boolean>
  readonly now: () => Date
  /** Resolves the live session's `SessionWorkspace` — until #322b puts `workspace` on the hosted
   *  snapshot, `main/ipc.ts` wires this through `resolveWorkspace` directly. `null` is `unknown-session`. */
  readonly workspaceOf: (sessionKey: string) => Promise<SessionWorkspace | null>
  readonly computeSessionChanges: typeof defaultComputeSessionChanges
  readonly pathOps?: PathOps
}

async function defaultExists(path: string): Promise<boolean> {
  const result = await statPath(path)
  return result.ok
}

export function defaultWorkspaceChannelDeps(userDataDir: string, workspaceOf: WorkspaceChannelDeps['workspaceOf']): WorkspaceChannelDeps {
  return {
    listRepositories,
    recents: createRecentsStore({ dir: userDataDir }),
    chooseFolder: defaultChooseFolder,
    git: defaultGitRunner(),
    exists: defaultExists,
    now: () => new Date(),
    workspaceOf,
    computeSessionChanges: defaultComputeSessionChanges,
  }
}

export async function resolveFoldersList(registryDeps: RegistryDeps, request: IpcMap['folders:list']['request'], deps: WorkspaceChannelDeps): Promise<IpcMap['folders:list']['response']> {
  if (request !== undefined) throw new Error("'folders:list' takes no payload")
  const ops = deps.pathOps ?? defaultPathOps

  const listed = await deps.listRepositories(registryDeps)
  const repositories = listed.ok ? listed.repositories : []
  const readyPaths = repositories.filter(isReadyEntry).map((entry) => entry.path)

  const registryFolders = await Promise.all(readyPaths.map((path) => toFolderEntry(path, { git: deps.git, repositories, lastUsedAt: null, pathOps: ops })))

  const recents = await deps.recents.load()
  const live = await pruneMissing(recents, deps.exists)
  const newRecents = live.filter((recent) => !readyPaths.some((path) => ops.samePath(path, recent.path)))

  const recentFolders = await Promise.all(newRecents.map((recent) => toFolderEntry(recent.path, { git: deps.git, repositories, lastUsedAt: recent.lastUsedAt, pathOps: ops })))

  const folders: readonly FolderEntry[] = [...registryFolders, ...recentFolders]
  return { folders }
}

export async function resolveFoldersChoose(registryDeps: RegistryDeps, request: IpcMap['folders:choose']['request'], deps: WorkspaceChannelDeps): Promise<IpcMap['folders:choose']['response']> {
  if (request !== undefined) throw new Error("'folders:choose' takes no payload")

  const picked = await deps.chooseFolder()
  if (picked === null) return { outcome: 'cancelled' }

  const listed = await deps.listRepositories(registryDeps)
  const repositories = listed.ok ? listed.repositories : []
  const now = deps.now()

  await deps.recents.record(picked, now)
  const folder = await toFolderEntry(picked, { git: deps.git, repositories, lastUsedAt: now.toISOString(), pathOps: deps.pathOps ?? defaultPathOps })
  return { outcome: 'chosen', folder }
}

export async function resolveSessionChanges(request: IpcMap['session:changes']['request'], deps: WorkspaceChannelDeps): Promise<SessionChanges> {
  if (typeof request?.sessionKey !== 'string' || request.sessionKey === '') {
    throw new Error("'session:changes' requires a non-empty 'sessionKey'")
  }
  const workspace = await deps.workspaceOf(request.sessionKey)
  if (workspace === null) return { ok: false, kind: 'unknown-session', message: `no session is open for key '${request.sessionKey}'` }
  return deps.computeSessionChanges(workspace, { git: deps.git })
}
