import { app, BrowserWindow, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { IPC_CHANNELS, type IpcChannel, type IpcEvent, type IpcEventMap, type IpcMap } from '@/types/ipc'
import type { ReadWorktreeReportParams, WorktreesReport } from '@/types/reclaimer'
import { SOURCE_KINDS, type BoardSnapshot } from '@/types/board'
import { chooseDirectory } from '@/main/dialogs'
import { defaultWorkspaceChannelDeps, resolveFoldersChoose, resolveFoldersList, resolveSessionChanges } from '@/main/channels/workspace'
import { createRecentsStore } from '@/main/workspace/recents'
import { createSessionWorktree, removeSessionWorktreeAt } from '@/main/workspace/worktree'
import { releaseStageBranch } from '@/main/workspace/stage-worktree'
import { createDefaultStageLauncher } from '@/main/stage/default'
import type { StageLauncherHandle, StageRegistry } from '@/types/stage'
import { defaultForkListSessions } from '@/main/hosting/fork'
import { statPath } from '@/main/platform/files'
import type { HostedStore, SessionKey } from '@/types/hosting'
import { applyItemAction } from '@/main/actions/apply'
import { applyItemDecision } from '@/main/actions/decide'
import { gateAnswer, gatePreflight } from '@/main/actions/gate'
import { resolveClaimApply, resolveClaimPreflight } from '@/main/channels/claim'
import { resolveBacklogList } from '@/main/channels/backlog'
import { resolveWorktreesReclaim } from '@/main/channels/worktrees'
import { resolveGhStatus } from '@/main/channels/gh'
import { createDispatchRuntime } from '@/main/dispatch/runtime'
import { createRunStateStore } from '@/main/dispatch/store'
import { defaultHaltDispatchDeps, haltDispatch } from '@/main/dispatch/halt'
import { registeredRepoIds, resolveDispatchControl } from '@/main/dispatch/resolve'
import type { Dispatcher } from '@/types/dispatch'
import { fetchItemsByNumber } from '@/main/github/adapter'
import { readOwnership, releaseOwnership, takeOwnership } from '@/main/dispatch/ownership'
import { resolveGateAnswer, resolveGatePreflight } from '@/main/channels/gate'
import type { GateChannelDeps, ItemDecisionDeps, StageChannelDeps } from '@/types/channels'
import { resolveItemAction, resolveItemDecision } from '@/main/channels/items'
import { resolveRuntimeProbe } from '@/main/channels/runtime'
import { resolveSearchQuery, resolveSessionsScan, resolveTranscriptTailClose, resolveTranscriptTailOpen, resolveTranscriptTailPoll } from '@/main/channels/sessions'
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
  resolveSessionIndex,
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
  resolveSessionTaskStop,
} from '@/main/channels/hosting'
import { defaultGitRunner, git } from '@/main/platform/git'
import { readWorktreeReport } from '@/main/reclaimer/report'
import { addRepository, listRepositories, removeRepository, requireReadyRepo } from '@/main/registry'
import type { RegistryDeps } from '@/types/registry'
import { createPipelineWatcher } from '@/main/state/watcher'
import type { PipelineWatcher } from '@/types/state'
import { runtimePreflight } from '@/main/runtime/preflight'
import { createHostedStore, defaultHostedStoreDeps } from '@/main/hosting/store'
import { createHostingPersistence } from '@/main/hosting/persist'
import { createSessionIndex } from '@/main/hosting/session-index'
import { createAppNotifier } from '@/main/hosting/notify'
import { createStageRegistry } from '@/main/stage/registry'
import { readJsonFile, writeJsonFileAtomic } from '@/main/platform/files'
import { createStageSweeper, resolveStageAllow, resolveStageDismissDenial, resolveStageResume, resolveStageRestart } from '@/main/channels/stage'
import { resolveForceDispatch } from '@/main/channels/held'
import { resolveNotifyNeedsYou } from '@/main/channels/notify'
import { createSessionMenuRefresher } from '@/main/session-menu'

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
    chromium: process.versions.chrome,
    commit: __PORT_BUILD_COMMIT__
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

interface RegisteredIpc {
  readonly watcher: PipelineWatcher
  readonly hostedStore: HostedStore
  readonly dispatcher: Dispatcher
  readonly shutdownDispatch: () => void
  readonly stageRegistry: StageRegistry
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

  // Shared by the workspace and hosting channels — `folders.json`'s one writer either way.
  const recents = createRecentsStore({ dir: app.getPath('userData') })

  // One hosted-session store for the process lifetime, created before the watcher — the dispatcher
  // sits between the two and needs this store first.
  const notifier = createAppNotifier({ registryDeps, broadcast: (command) => broadcast('app:command', command) })

  // Assigned right after createDispatchRuntime below — stageLauncher's onOutcome closes over it,
  // so construction order between the launcher and the dispatcher that owns recordOutcome stays acyclic.
  let dispatcherRef: Dispatcher | null = null

  // stage-sessions.json's sole writer. Loaded once at boot — a `running` entry found then can only
  // mean the process died before it marked itself otherwise, and promotes to `crash`.
  const stageRegistry = createStageRegistry({ path: join(app.getPath('userData'), 'stage-sessions.json'), readJson: readJsonFile, writeJsonAtomic: writeJsonFileAtomic, now: () => new Date() })
  void stageRegistry.load()

  const sessionIndex = createSessionIndex({ path: join(app.getPath('userData'), 'session-index.json'), readJson: readJsonFile, writeJsonAtomic: writeJsonFileAtomic, now: () => new Date() })
  void sessionIndex.load()

  const hostedStore = createHostedStore({
    ...defaultHostedStoreDeps,
    onStatus: (snapshot) => {
      broadcast('session:status', snapshot)
      sessionIndex.observe(snapshot)
      notifier.observe(snapshot)
      stageLauncher.observe(snapshot)
      sessionMenu.refresh()
    },
    onEntries: (delta) => broadcast('session:entries', delta),
    persistence: createHostingPersistence({ dir: app.getPath('userData') }),
  })
  const sessionMenu = createSessionMenuRefresher({ store: hostedStore, platform: process.platform, isPackaged: app.isPackaged, send: broadcastAppCommand })

  const stageLauncher: StageLauncherHandle = createDefaultStageLauncher({
    store: hostedStore,
    registry: stageRegistry,
    onOutcome: (repoId, sessionKey, outcome) => dispatcherRef?.recordOutcome(repoId, sessionKey, outcome),
    onDenial: (repoId, denial) => dispatcherRef?.recordDenial(repoId, denial),
  })
  const hostingChannelDeps = defaultHostingChannelDeps(hostedStore, sessionIndex, {
    git: (args, cwd) => git(args, { cwd }),
    recents,
    exists: async (path) => (await statPath(path)).ok,
    readSessions: defaultForkListSessions,
    createWorktree: createSessionWorktree,
  })

  const { watcherDeps, dispatcher, forceDispatch, autoPlanner, bindWatcher, shutdown } = createDispatchRuntime({
    store: hostedStore,
    launch: stageLauncher,
    runState: (repoId) => runStates.current(repoId).state,
    readOwnership,
    takeOwnership,
    fetchItemsByNumber,
    listRepositories,
    registryDeps,
    dirs: { audit: app.getPath('userData'), scratch: app.getPath('temp') },
    now: () => new Date(),
    interrupted: (repoId) => stageRegistry.list().filter((entry) => entry.repoId === repoId),
  })
  dispatcherRef = dispatcher

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
      void stageSweeper.consider(snapshot, dispatcher.status())
    },
  })
  bindWatcher(watcher)

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

  handle('session:pin:set', (_event, request) => sessionMenu.withRefresh(resolveSessionPinSet(request, hostingChannelDeps)))

  handle('session:archive:set', (_event, request) => sessionMenu.withRefresh(resolveSessionArchiveSet(request, hostingChannelDeps)))

  handle('item:action', (_event, request) =>
    resolveItemAction(registryDeps, request, app.getPath('userData'), { listRepositories, applyItemAction, snapshot: watcher.snapshot, refresh: watcher.refresh }),
  )

  handle('item:decide', (_event, request) =>
    resolveItemDecision(registryDeps, request, app.getPath('userData'), app.getPath('temp'), {
      listRepositories,
      applyItemDecision,
      sessions: () => hostedStore.list(),
      snapshot: watcher.snapshot,
      refresh: watcher.refresh,
    } satisfies ItemDecisionDeps),
  )

  // run/drain/pause/take-over, scoped to one repository — all branching in `resolveDispatchControl`.
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

  handle('session:index', (_event, request) => resolveSessionIndex(request, hostingChannelDeps))

  handle('session:permission:answer', (_event, request) => resolveSessionPermissionAnswer(request, hostingChannelDeps))

  handle('session:invoke', (_event, request) => resolveSessionInvoke(request, hostingChannelDeps))

  handle('session:dismiss', (_event, request) => sessionMenu.withRefresh(resolveSessionDismiss(request, hostingChannelDeps)))

  handle('session:task:stop', (_event, request) => resolveSessionTaskStop(request, hostingChannelDeps))

  handle('session:capacity', (_event, request) => resolveSessionCapacity(request, hostingChannelDeps))

  handle('session:capacity:set', (_event, request) => resolveSessionCapacitySet(request, hostingChannelDeps))

  handle('session:restore:list', (_event, request) => resolveSessionRestoreList(registryDeps, request, hostingChannelDeps))

  handle('session:restore', (_event, request) => resolveSessionRestore(registryDeps, request, hostingChannelDeps))

  handle('session:restore:discard', (_event, request) => resolveSessionRestoreDiscard(request, hostingChannelDeps))

  function workspaceOf(sessionKey: string) {
    return Promise.resolve(hostedStore.snapshotOf(sessionKey as SessionKey)?.workspace ?? null)
  }

  const workspaceChannelDeps = defaultWorkspaceChannelDeps(app.getPath('userData'), workspaceOf, recents)

  handle('folders:list', (_event, request) => resolveFoldersList(registryDeps, request, workspaceChannelDeps))

  handle('folders:choose', (_event, request) => resolveFoldersChoose(registryDeps, request, workspaceChannelDeps))

  handle('session:changes', (_event, request) => resolveSessionChanges(request, workspaceChannelDeps))

  const stageChannelDeps: StageChannelDeps = {
    listRepositories,
    registry: stageRegistry,
    dispatcher,
    store: hostedStore,
    launcher: stageLauncher,
    removeWorktree: (path, force) => removeSessionWorktreeAt({ path, force, git: defaultGitRunner() }),
    releaseBranch: (root, branch, baseSha) => releaseStageBranch({ root, git: defaultGitRunner(), branch, baseSha }),
    applyItemAction,
    snapshot: watcher.snapshot,
    auditDir: app.getPath('userData'),
    readJson: readJsonFile,
    writeJsonAtomic: writeJsonFileAtomic,
  }
  const stageSweeper = createStageSweeper(registryDeps, stageChannelDeps, { fetchItemsByNumber, onChange: () => watcher.republish() })

  handle('stage:allow', (_event, request) => resolveStageAllow(registryDeps, request, stageChannelDeps))

  handle('stage:dismiss-denial', (_event, request) => resolveStageDismissDenial(request, stageChannelDeps))

  handle('stage:resume', (_event, request) => resolveStageResume(registryDeps, request, stageChannelDeps))

  handle('stage:restart', (_event, request) => resolveStageRestart(registryDeps, request, stageChannelDeps))

  handle('notify:needs-you', (_event, request) => resolveNotifyNeedsYou(request, { show: (notification) => notifier.showNeedsYou(notification) }))

  handle('held:force-dispatch', (_event, request) => resolveForceDispatch(request, { snapshot: watcher.snapshot, dispatcherStatus: () => dispatcher.status(), forceDispatch, republish: () => watcher.republish() }))

  for (const channel of IPC_CHANNELS) {
    if (!registered.has(channel)) {
      throw new Error(`IPC channel '${channel}' is declared but has no handler`)
    }
  }

  return { watcher, hostedStore, dispatcher, shutdownDispatch: shutdown, stageRegistry }
}
