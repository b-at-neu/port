import { app, BrowserWindow, ipcMain, Notification } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { IPC_CHANNELS, type IpcChannel, type IpcEvent, type IpcEventMap, type IpcMap } from '../shared/ipc'
import type { WorktreesReport } from '../shared/reclaimer/types'
import { SOURCE_KINDS } from '../shared/board/types'
import type { BoardSnapshot } from '../shared/board/types'
import { chooseDirectory } from './dialogs'
import { defaultWorkspaceChannelDeps, resolveFoldersChoose, resolveFoldersList, resolveSessionChanges } from './channels/workspace'
import { resolveWorkspace } from './workspace/resolve'
import type { SessionKey } from '../shared/hosting/types'
import { applyItemAction } from './actions/apply'
import { applyItemDecision } from './actions/decide'
import { gateAnswer, gatePreflight } from './actions/gate'
import { resolveClaimApply, resolveClaimPreflight } from './channels/claim'
import { resolveBacklogList } from './channels/backlog'
import { resolveWorktreesReclaim } from './channels/worktrees'
import { resolveGhStatus } from './channels/gh'
import { createDispatchRuntime } from './dispatch/runtime'
import { createRunStateStore } from './dispatch/store'
import { defaultHaltDispatchDeps, haltDispatch } from './dispatch/halt'
import { registeredRepoIds, resolveDispatchControl } from './dispatch/resolve'
import type { Dispatcher } from './dispatch/dispatcher'
import { fetchItemsByNumber } from './github/adapter'
import { readOwnership, releaseOwnership, takeOwnership } from './dispatch/ownership'
import { resolveGateAnswer, resolveGatePreflight } from './channels/gate'
import type { GateChannelDeps } from './channels/gate'
import { resolveItemAction, resolveItemDecision } from './channels/items'
import type { ItemDecisionDeps } from './channels/items'
import { resolveRuntimeProbe } from './channels/runtime'
import { resolveSearchQuery, resolveSessionsScan, resolveTranscriptTailClose, resolveTranscriptTailOpen, resolveTranscriptTailPoll } from './channels/sessions'
import {
  defaultHostingChannelDeps,
  resolveSessionAttach,
  resolveSessionCapacity,
  resolveSessionCapacitySet,
  resolveSessionClose,
  resolveSessionDefaults,
  resolveSessionDefaultsSet,
  resolveSessionDismiss,
  resolveSessionFiles,
  resolveSessionInterrupt,
  resolveSessionInvoke,
  resolveSessionList,
  resolveSessionPermissionAnswer,
  resolveSessionControlsSet,
  resolveSessionQuestionAnswer,
  resolveSessionPlanAnswer,
  resolveSessionArchiveSet,
  resolveSessionMarks,
  resolveSessionPinSet,
  resolveSessionRename,
  resolveSessionRestore,
  resolveSessionRestoreDiscard,
  resolveSessionRestoreList,
  resolveSessionSend,
  resolveSessionStart,
} from './channels/hosting'
import { git } from './platform/git'
import { readWorktreeReport } from './reclaimer/report'
import type { ReadWorktreeReportParams } from './reclaimer/report'
import { addRepository, isReadyEntry, listRepositories, removeRepository, requireReadyRepo } from './registry'
import type { RegistryDeps } from './registry'
import { createPipelineWatcher } from './state/watcher'
import type { PipelineWatcher } from './state/watcher'
import { runtimePreflight } from './runtime/preflight'
import { createHostedStore, defaultHostedStoreDeps } from './hosting/store'
import { createHostingPersistence } from './hosting/persist'
import type { HostedStore } from './hosting/store'
import { createNotifier } from './hosting/notify'

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

// The one place every main → renderer push goes through.
function broadcast<E extends IpcEvent>(event: E, payload: IpcEventMap[E]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(event, payload)
  }
}

/** `main/index.ts`'s own menu click handler — the app menu has no other way to reach the renderer. */
export function broadcastAppCommand(command: IpcEventMap['app:command']): void {
  broadcast('app:command', command)
}

function getAppInfo(): AppInfo {
  return {
    app: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chromium: process.versions.chrome
  }
}

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

export interface BoardRefreshDeps {
  readonly listRepositories: typeof listRepositories
  readonly refresh: (request: IpcMap['board:refresh']['request']) => Promise<BoardSnapshot>
}

export async function resolveBoardRefresh(
  registryDeps: RegistryDeps,
  request: IpcMap['board:refresh']['request'],
  deps: BoardRefreshDeps,
): Promise<BoardSnapshot> {
  if (request?.repoId !== undefined) {
    if (typeof request.repoId !== 'string' || request.repoId === '') {
      throw new Error("'board:refresh' repoId must be a non-empty string when present")
    }
    const list = await deps.listRepositories(registryDeps)
    if (!list.ok) throw new Error(`'board:refresh' could not list repositories: ${list.message}`)
    if (!list.repositories.some((repository) => repository.id === request.repoId)) {
      throw new Error(`'board:refresh' found no repository registered with id '${request.repoId}'`)
    }
  }
  if (request?.source !== undefined && !(SOURCE_KINDS as readonly string[]).includes(request.source)) {
    throw new Error(`'board:refresh' source must be one of ${SOURCE_KINDS.join(', ')}`)
  }
  return deps.refresh(request)
}

export interface RegisteredIpc {
  readonly watcher: PipelineWatcher
  readonly hostedStore: HostedStore
  readonly dispatcher: Dispatcher
  readonly shutdownDispatch: () => void
}

export function registerIpc(): RegisteredIpc {
  // The one place a real `git` invocation and the real userData directory reach the registry.
  const registryDeps: RegistryDeps = {
    registryDir: app.getPath('userData'),
    git: (args, cwd) => git(args, { cwd }),
    chooseDirectory,
  }

  // Created before `repos:add`/`repos:remove` so their handlers can forget a stale entry.
  const runStates = createRunStateStore(app.getPath('userData'))
  void runStates.load(() => registeredRepoIds(registryDeps))

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

  // Forgetting a run-state entry never fails the registry call itself, only logs.
  function forgetRunState(channel: string, repoId: Parameters<typeof runStates.forget>[0]): void {
    void runStates.forget(repoId).then((f) => {
      if (!f.ok) console.error(`'${channel}' could not forget the run-state entry for '${String(repoId)}':`, f.message)
    })
  }

  handle('repos:add', async (_event, request) => {
    if (request !== undefined) throw new Error("'repos:add' takes no payload")
    const result = await addRepository(registryDeps)
    if (result.ok && result.outcome === 'added') forgetRunState('repos:add', result.added)
    return result
  })

  handle('repos:remove', async (_event, request) => {
    if (typeof request?.id !== 'string' || request.id === '') throw new Error("'repos:remove' requires a non-empty 'id'")
    const result = await removeRepository(registryDeps, request.id)
    if (result.ok) forgetRunState('repos:remove', request.id)
    return result
  })

  handle('worktrees:report', (_event, request) => resolveWorktreesReport(registryDeps, request))

  handle('worktrees:reclaim', (_event, request) => resolveWorktreesReclaim(registryDeps, request, app.getPath('userData')))

  handle('sessions:scan', (_event, request) => {
    if (request !== undefined) {
      throw new Error("'sessions:scan' takes no payload")
    }
    return resolveSessionsScan(registryDeps)
  })

  handle('transcript:tail:open', (_event, request) => resolveTranscriptTailOpen(request))

  handle('transcript:tail:poll', (_event, request) => resolveTranscriptTailPoll(request))

  handle('transcript:tail:close', (_event, request) => resolveTranscriptTailClose(request))

  handle('search:query', (_event, request) => resolveSearchQuery(registryDeps, request, app.getPath('userData')))

  // One hosted-session store for the process lifetime, created before the watcher — the dispatcher
  // sits between the two and needs this store first.
  const notifier = createNotifier({
    isAppFocused: () => BrowserWindow.getFocusedWindow() !== null,
    repoLabel: (snapshot) => String(snapshot.repoId),
    show: (notification, snapshot) => {
      if (!Notification.isSupported()) return
      const native = new Notification({ title: notification.title, body: notification.body })
      native.on('click', () => {
        const [window] = BrowserWindow.getAllWindows()
        if (window !== undefined) {
          if (window.isMinimized()) window.restore()
          window.show()
          window.focus()
        }
        broadcast('app:command', { kind: 'open-session', sessionKey: snapshot.sessionKey })
      })
      native.show()
    },
  })

  const hostedStore = createHostedStore({
    ...defaultHostedStoreDeps,
    onStatus: (snapshot) => {
      broadcast('session:status', snapshot)
      notifier.observe(snapshot)
    },
    onEntries: (delta) => broadcast('session:entries', delta),
    persistence: createHostingPersistence({ dir: app.getPath('userData') }),
  })
  const hostingChannelDeps = defaultHostingChannelDeps(hostedStore)

  // `launch: null` is the honest state until a real `StageLauncher` lands — a candidate sits
  // visibly at `no-launcher` rather than silently idle.
  const { watcherDeps, dispatcher, autoPlanner, bindWatcher, shutdown } = createDispatchRuntime({
    store: hostedStore,
    launch: null,
    runState: (repoId) => runStates.current(repoId).state,
    readOwnership,
    takeOwnership,
    fetchItemsByNumber,
    listRepositories,
    registryDeps,
    dirs: { audit: app.getPath('userData'), scratch: app.getPath('temp') },
    now: () => new Date(),
  })

  // One watcher for the process lifetime. `onTick` fires only on a fresh poll, never awaited —
  // a pass must never block the broadcast the renderer is waiting on.
  const watcher = createPipelineWatcher({
    repositories: async () => {
      const list = await listRepositories(registryDeps)
      return list.ok ? list.repositories : []
    },
    git: (args, cwd) => git(args, { cwd }),
    runStates: (repoIds) => runStates.snapshot(repoIds),
    ...watcherDeps,
    onSnapshot: (snapshot) => {
      broadcast('board:update', snapshot)
      void autoPlanner.consider(snapshot)
    },
    onTick: (snapshot) => {
      void dispatcher.consider(snapshot)
    },
  })
  bindWatcher(() => watcher.republish())

  handle('board:snapshot', (_event, request) => {
    if (request !== undefined) {
      throw new Error("'board:snapshot' takes no payload")
    }
    return watcher.snapshot()
  })

  handle('board:refresh', (_event, request) => resolveBoardRefresh(registryDeps, request, { listRepositories, refresh: watcher.refresh }))

  handle('claim:preflight', (_event, request) => resolveClaimPreflight(registryDeps, request))

  handle('claim:apply', (_event, request) => resolveClaimApply(registryDeps, request, app.getPath('userData')))

  handle('backlog:list', (_event, request) => resolveBacklogList(registryDeps, request))

  handle('gh:status', (_event, request) => resolveGhStatus(request))

  handle('session:defaults', (_event, request) => resolveSessionDefaults(request, hostingChannelDeps))

  handle('session:defaults:set', (_event, request) => resolveSessionDefaultsSet(request, hostingChannelDeps))

  handle('session:rename', (_event, request) => resolveSessionRename(request, hostingChannelDeps))

  handle('session:controls:set', (_event, request) => resolveSessionControlsSet(request, hostingChannelDeps))

  handle('session:question:answer', (_event, request) => resolveSessionQuestionAnswer(request, hostingChannelDeps))

  handle('session:plan:answer', (_event, request) => resolveSessionPlanAnswer(request, hostingChannelDeps))

  handle('session:files', (_event, request) => resolveSessionFiles(request, hostingChannelDeps))

  handle('session:marks', (_event, request) => resolveSessionMarks(request, hostingChannelDeps))

  handle('session:pin:set', (_event, request) => resolveSessionPinSet(request, hostingChannelDeps))

  handle('session:archive:set', (_event, request) => resolveSessionArchiveSet(request, hostingChannelDeps))

  handle('item:action', (_event, request) =>
    resolveItemAction(registryDeps, request, app.getPath('userData'), { listRepositories, applyItemAction, snapshot: watcher.snapshot, refresh: watcher.refresh }),
  )

  handle('item:decide', (_event, request) =>
    resolveItemDecision(registryDeps, request, app.getPath('userData'), app.getPath('temp'), {
      listRepositories,
      applyItemDecision,
      snapshot: watcher.snapshot,
      refresh: watcher.refresh,
    } satisfies ItemDecisionDeps),
  )

  // run/drain/pause/take-over one repository, or halt everything — all branching in `resolveDispatchControl`.
  handle('dispatch:control', (_event, request) =>
    resolveDispatchControl(registryDeps, request, {
      listRepositories,
      runStates,
      haltDispatch: (params) =>
        haltDispatch(params, { ...defaultHaltDispatchDeps, stopFor: (repoId, number) => dispatcher.stopFor(repoId, number), standDown: (repoId) => dispatcher.standDown(repoId) }),
      takeOwnership,
      releaseOwnership,
      snapshot: watcher.snapshot,
      refresh: watcher.refresh,
      auditDir: app.getPath('userData'),
      now: () => new Date(),
    }),
  )

  handle('runtime:preflight', (_event, request) => {
    if (request !== undefined) throw new Error("'runtime:preflight' takes no payload")
    return runtimePreflight()
  })

  handle('runtime:probe', (_event, request) => resolveRuntimeProbe(registryDeps, request, join(app.getPath('userData'), 'runtime-probe')))

  // `refresh` is the live watcher's method, never a second poll built here.
  const gateChannelDeps: GateChannelDeps = { gatePreflight, gateAnswer, refresh: watcher.refresh }

  handle('gate:preflight', (_event, request) => resolveGatePreflight(registryDeps, request, gateChannelDeps))

  handle('gate:answer', (_event, request) => resolveGateAnswer(registryDeps, request, app.getPath('userData'), app.getPath('temp'), gateChannelDeps))

  handle('session:start', (_event, request) => resolveSessionStart(registryDeps, request, hostingChannelDeps))

  handle('session:send', (_event, request) => resolveSessionSend(request, hostingChannelDeps))

  handle('session:interrupt', (_event, request) => resolveSessionInterrupt(request, hostingChannelDeps))

  handle('session:close', (_event, request) => resolveSessionClose(request, hostingChannelDeps))

  handle('session:attach', (_event, request) => resolveSessionAttach(request, hostingChannelDeps))

  handle('session:list', (_event, request) => resolveSessionList(request, hostingChannelDeps))

  handle('session:permission:answer', (_event, request) => resolveSessionPermissionAnswer(request, hostingChannelDeps))

  handle('session:invoke', (_event, request) => resolveSessionInvoke(request, hostingChannelDeps))

  handle('session:dismiss', (_event, request) => resolveSessionDismiss(request, hostingChannelDeps))

  handle('session:capacity', (_event, request) => resolveSessionCapacity(request, hostingChannelDeps))

  handle('session:capacity:set', (_event, request) => resolveSessionCapacitySet(request, hostingChannelDeps))

  handle('session:restore:list', (_event, request) => resolveSessionRestoreList(registryDeps, request, hostingChannelDeps))

  handle('session:restore', (_event, request) => resolveSessionRestore(registryDeps, request, hostingChannelDeps))

  handle('session:restore:discard', (_event, request) => resolveSessionRestoreDiscard(request, hostingChannelDeps))

  // Interim lookup: no session carries a worktree yet, so this resolves the registered repo's own
  // path — the same non-worktree semantics `resolve.ts` already handles for any other folder.
  async function workspaceOf(sessionKey: string) {
    const snapshot = hostedStore.snapshotOf(sessionKey as SessionKey)
    if (snapshot === null) return null
    const list = await listRepositories(registryDeps)
    if (!list.ok) return null
    const entry = list.repositories.find((repository) => repository.id === snapshot.repoId)
    if (entry === undefined || !isReadyEntry(entry)) return null
    const { workspace } = await resolveWorkspace(entry.path, { git: registryDeps.git, repositories: list.repositories })
    return workspace
  }

  const workspaceChannelDeps = defaultWorkspaceChannelDeps(app.getPath('userData'), workspaceOf)

  handle('folders:list', (_event, request) => resolveFoldersList(registryDeps, request, workspaceChannelDeps))

  handle('folders:choose', (_event, request) => resolveFoldersChoose(registryDeps, request, workspaceChannelDeps))

  handle('session:changes', (_event, request) => resolveSessionChanges(request, workspaceChannelDeps))

  for (const channel of IPC_CHANNELS) {
    if (!registered.has(channel)) {
      throw new Error(`IPC channel '${channel}' is declared but has no handler`)
    }
  }

  return { watcher, hostedStore, dispatcher, shutdownDispatch: shutdown }
}
