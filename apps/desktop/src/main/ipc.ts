import { app, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS, type IpcChannel, type IpcMap } from '../shared/ipc'
import type { WorktreesReport } from '../shared/reclaimer/types'
import { chooseDirectory } from './dialogs'
import { git } from './platform'
import { readWorktreeReport } from './reclaimer'
import type { ReadWorktreeReportParams } from './reclaimer'
import { addRepository, listRepositories, removeRepository } from './registry'
import type { RegistryDeps } from './registry'

type AppInfo = IpcMap['app:info']['response']

type Handler<C extends IpcChannel> = (
  event: IpcMainInvokeEvent,
  request: IpcMap[C]['request']
) => IpcMap[C]['response'] | Promise<IpcMap[C]['response']>

const registered = new Set<IpcChannel>()

function handle<C extends IpcChannel>(channel: C, handler: Handler<C>): void {
  registered.add(channel)
  ipcMain.handle(channel, async (event, request: IpcMap[C]['request']) => {
    try {
      return await handler(event, request)
    } catch (error) {
      console.error(`[ipc] ${channel} failed`, error)
      throw error
    }
  })
}

function getAppInfo(): AppInfo {
  return {
    app: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chromium: process.versions.chrome
  }
}

/** The two calls `'worktrees:report'` composes — injected so the
 *  id-validation/lookup/ready-check branching below is testable without
 *  Electron or a real registry, the same seam `RegistryDeps` gives the
 *  registry functions themselves. */
export interface WorktreesReportDeps {
  readonly listRepositories: typeof listRepositories
  readonly readWorktreeReport: (params: ReadWorktreeReportParams) => Promise<WorktreesReport>
}

const defaultWorktreesReportDeps: WorktreesReportDeps = { listRepositories, readWorktreeReport }

/** The renderer sends only the opaque id, never a path — resolved here
 *  through the same registry every other channel reads, so a repository
 *  that has moved, gone stale, or lost its 'ready' status is caught before
 *  anything is spawned. */
export async function resolveWorktreesReport(
  registryDeps: RegistryDeps,
  request: IpcMap['worktrees:report']['request'],
  deps: WorktreesReportDeps = defaultWorktreesReportDeps,
): Promise<WorktreesReport> {
  if (typeof request?.id !== 'string' || request.id === '') {
    throw new Error("'worktrees:report' requires a non-empty 'id'")
  }
  const list = await deps.listRepositories(registryDeps)
  if (!list.ok) throw new Error(`'worktrees:report' could not list repositories: ${list.message}`)
  const entry = list.repositories.find((repository) => repository.id === request.id)
  if (!entry) throw new Error(`'worktrees:report' found no repository registered with id '${request.id}'`)
  if (!('config' in entry)) throw new Error(`'worktrees:report' requires a 'ready' repository, got '${entry.problem.kind}'`)
  return deps.readWorktreeReport({
    repoRoot: entry.path,
    worktreesCommand: entry.config.commands.worktrees,
    git: registryDeps.git,
  })
}

export function registerIpc(): void {
  // The one place a real `git` invocation and the real userData directory
  // reach the registry — every registry function itself takes these as
  // injected dependencies, so its own tests need neither Electron nor a
  // real repository.
  const registryDeps: RegistryDeps = {
    registryDir: app.getPath('userData'),
    git: (args, cwd) => git(args, { cwd }),
    chooseDirectory,
  }

  handle('app:info', (_event, request) => {
    if (request !== undefined) {
      throw new Error("'app:info' takes no payload")
    }
    return getAppInfo()
  })

  handle('repos:list', (_event, request) => {
    if (request !== undefined) {
      throw new Error("'repos:list' takes no payload")
    }
    return listRepositories(registryDeps)
  })

  handle('repos:add', (_event, request) => {
    if (request !== undefined) {
      throw new Error("'repos:add' takes no payload")
    }
    return addRepository(registryDeps)
  })

  handle('repos:remove', (_event, request) => {
    if (typeof request?.id !== 'string' || request.id === '') {
      throw new Error("'repos:remove' requires a non-empty 'id'")
    }
    return removeRepository(registryDeps, request.id)
  })

  handle('worktrees:report', (_event, request) => resolveWorktreesReport(registryDeps, request))

  for (const channel of IPC_CHANNELS) {
    if (!registered.has(channel)) {
      throw new Error(`IPC channel '${channel}' is declared but has no handler`)
    }
  }
}
