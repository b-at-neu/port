// The composition root: everything an action may touch, built once at startup, one block per service.
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { EventMap, EventName } from '@/main/app/events'
import { chooseDirectory, chooseFolder, chooseSavePath } from '@/main/app/shell/dialogs'
import { createIncidentLog } from '@/main/pipeline/incidents/log'
import { defaultWorkspaceChannelDeps } from '@/main/features/folders/resolve'
import { createRecentsStore } from '@/main/features/folders/recents'
import { removeSessionWorktreeAt } from '@/main/repos/worktree/worktree'
import { releaseStageBranch } from '@/main/repos/worktree/stage-worktree'
import { createDefaultStageLauncher } from '@/main/dispatch/stage/default'
import { createOffload } from '@/main/worker/deps'
import { bindOperator } from '@/main/app/operator'
import { createPipelineState } from '@/main/pipeline/state/default'
import { defaultHostingChannelDeps } from '@/main/features/session/resolve'
import { createDispatchRuntime } from '@/main/dispatch/runtime'
import { fetchItemsByNumber } from '@/main/github/tracker/items'
import { readAllowBase } from '@/main/github/allow'
import { proposeAllowRule } from '@/main/github/writes/allow'
import type { FetchItemsByNumberParams } from '@/types/github'
import { readOwnership, takeOwnership } from '@/main/repos/ownership'
import type { GateChannelDeps, HostingChannelDeps, IncidentChannelDeps, StageChannelDeps } from '@/main/app/seams'
import { createPlatform, type Platform } from '@/main/platform'
import { nativeNotify } from '@/main/platform/notify'
import { createRepos, listRepositories, type Repos } from '@/main/repos'
import { createPipelineWatcher } from '@/main/pipeline/board/watcher'
import { createHostedStore, defaultHostedStoreDeps } from '@/main/sessions/hosting/store'
import { createHostingPersistence } from '@/main/sessions/hosting/persist'
import { createSessionIndex } from '@/main/sessions/hosting/session-index'
import { createAppNotifier } from '@/main/sessions/hosting/notify'
import { createStageSweeper } from '@/main/features/stage/resolve'
import { createUsageLedger } from '@/main/sessions/hosting/usage-ledger'
import { createSessionMenuRefresher } from '@/main/app/shell/session-menu'
import { createDefaultUpdate } from '@/main/features/update/default'
import type { RestartSeams } from '@/types/update'
import type { Dispatcher, OwnershipParams, RunStateStore } from '@/types/dispatch'
import type { HostedStore } from '@/types/hosting'
import type { PipelineWatcher } from '@/types/state'
import type { ForceDispatch } from '@/types/tick'
import type { SessionIndex } from '@/types/session-index'
import type { RunStore, StageLauncherHandle } from '@/types/stage'
import type { IncidentLog } from '@/types/incidents'
import type { RecentsStore } from '@/types/workspace'
import type { UsageLedger } from '@/types/settings'
import type { WorkspaceChannelDeps } from '@/main/features/folders/resolve'
import type { SessionKey } from '@/types/hosting'
import type { AppCommand } from '@/utils/shell/commands'

type Offload = ReturnType<typeof createOffload>

export type AppContext = Platform & {
  /** The one broadcast to every renderer window. */
  readonly emit: <E extends EventName>(event: E, payload: EventMap[E]) => void
  readonly repos: Repos
  readonly stores: {
    readonly runStates: RunStateStore
    readonly sessionIndex: SessionIndex
    readonly usageLedger: UsageLedger
    readonly runs: RunStore
    readonly recents: RecentsStore
    readonly pipelineState: ReturnType<typeof createPipelineState>
    readonly incidentLog: IncidentLog
  }
  readonly live: {
    readonly watcher: PipelineWatcher
    readonly hostedStore: HostedStore
    readonly dispatcher: Dispatcher
    readonly stageLauncher: StageLauncherHandle
    readonly offload: Omit<Offload, 'engine' | 'close'>
    readonly engine: Offload['engine']
    readonly notifier: ReturnType<typeof createAppNotifier>
    readonly sessionMenu: ReturnType<typeof createSessionMenuRefresher>
    readonly update: ReturnType<typeof createDefaultUpdate>
    readonly forceDispatch: ForceDispatch
    readonly actions: ReturnType<typeof bindOperator>
    readonly stageSweeper: ReturnType<typeof createStageSweeper>
    /** Stops the dispatcher and closes the worker. */
    readonly shutdown: () => void
  }
  readonly seams: {
    readonly hosting: HostingChannelDeps
    readonly workspace: WorkspaceChannelDeps
    readonly stage: StageChannelDeps
    readonly incidents: IncidentChannelDeps
    readonly gate: GateChannelDeps
  }
}

function emit<E extends EventName>(event: E, payload: EventMap[E]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(event, payload)
  }
}

/** The app menu's own click handler — the menu has no other way to reach the renderer. */
export function broadcastAppCommand(command: AppCommand): void {
  emit('app.command', command)
}

export function createAppContext(restart: RestartSeams): AppContext {
  const userData = app.getPath('userData')
  const platform = createPlatform({
    paths: { userData, temp: app.getPath('temp'), logs: app.getPath('logs') },
    info: () => ({ app: app.getVersion(), electron: process.versions.electron, node: process.versions.node, chromium: process.versions.chrome, commit: __PORT_BUILD_COMMIT__ }),
    dialogs: { chooseDirectory, chooseFolder, chooseSavePath },
    notify: nativeNotify,
  })
  const repos = createRepos(platform)

  const recents = createRecentsStore({ dir: userData })

  const incidentLog = createIncidentLog({ dir: userData, now: platform.clock.now, newId: () => globalThis.crypto.randomUUID() })

  const ownership = {
    read: (params: OwnershipParams) => readOwnership(platform, params),
    take: (params: OwnershipParams) => takeOwnership(platform, params),
  }

  const fetchItems = (params: FetchItemsByNumberParams) => fetchItemsByNumber(platform, params)

  // Loading it once at boot marks every run a lost process left open `crash`.
  const pipelineState = createPipelineState({ dir: userData, auditDir: userData, recordIncident: incidentLog.record, readOwnership: ownership.read, platform })
  const { runs, runStates } = pipelineState

  const sessionIndex = createSessionIndex({ path: join(userData, 'session-index.json'), readJson: platform.fs.readJson, writeJsonAtomic: platform.fs.writeJsonAtomic, now: platform.clock.now })
  void sessionIndex.load()

  const usageLedger = createUsageLedger({ path: join(userData, 'usage-ledger.json'), readJson: platform.fs.readJson, writeJsonAtomic: platform.fs.writeJsonAtomic, now: platform.clock.now, bootId: globalThis.crypto.randomUUID() })
  void usageLedger.load()

  const { engine, close: closeOffload, ...offload } = createOffload({ onRespawn: () => void watcher.refresh() })

  const actions = bindOperator(platform, pipelineState, ownership.read)

  const notifier = createAppNotifier({ registryDeps: repos.deps, broadcast: (command) => emit('app.command', command), prefs: () => hostedStore.notificationPrefs() })

  // Assigned right after createDispatchRuntime below — stageLauncher's onOutcome closes over it, so construction order stays acyclic.
  let dispatcherRef: Dispatcher | null = null

  const hostedStore = createHostedStore({
    ...defaultHostedStoreDeps,
    listSessionsForFork: () => engine.listSessions(),
    onStatus: (snapshot) => {
      emit('session.status', snapshot)
      sessionIndex.observe(snapshot)
      usageLedger.observe(snapshot)
      notifier.observe(snapshot)
      stageLauncher.observe(snapshot)
      sessionMenu.refresh()
    },
    onEntries: (delta) => emit('session.entries', delta),
    persistence: createHostingPersistence({ dir: userData }),
  })
  const sessionMenu = createSessionMenuRefresher({ store: hostedStore, platform: process.platform, isPackaged: app.isPackaged, send: broadcastAppCommand })
  const stageLauncher: StageLauncherHandle = createDefaultStageLauncher({
    store: hostedStore,
    runs,
    onOutcome: (repoId, sessionKey, outcome, plan) => dispatcherRef?.recordOutcome(repoId, sessionKey, outcome, plan),
    onResumedTurn: (repoId, sessionKey) => dispatcherRef?.recordResumedTurn(repoId, sessionKey),
    bundle: { isPackaged: app.isPackaged, mainDir: __dirname, resourcesPath: process.resourcesPath },
  })
  const hosting = defaultHostingChannelDeps(hostedStore, sessionIndex, { ctx: platform, recents, readSessions: () => engine.listSessions() })

  const { watcherDeps, dispatcher, forceDispatch, autoPlanner, bindWatcher, shutdown } = createDispatchRuntime({
    store: hostedStore,
    runs,
    launch: stageLauncher,
    runState: (repoId) => runStates.current(repoId).state,
    readOwnership: ownership.read,
    takeOwnership: ownership.take,
    fetchItemsByNumber: fetchItems,
    platform,
    listRepositories,
    registryDeps: repos.deps,
    actions,
    stateLabels: pipelineState.stateLabels,
    dirs: { audit: userData, scratch: platform.paths.temp },
    now: platform.clock.now,
    recordIncident: incidentLog.record,
  })
  dispatcherRef = dispatcher

  // One watcher for the process lifetime. `onTick` fires only on a fresh poll, never awaited.
  const watcher = createPipelineWatcher({
    engine,
    repositories: async ({ fresh }) => {
      const list = await repos.list({ fresh })
      return list.ok ? list.repositories : []
    },
    git: platform.git,
    runStates: (repoIds) => runStates.snapshot(repoIds),
    ...watcherDeps,
    ...pipelineState.watcherDeps,
    onSnapshot: (snapshot) => {
      emit('board.update', snapshot)
      void autoPlanner.consider(snapshot)
    },
    onTick: (snapshot) => {
      void dispatcher.consider(snapshot)
      void stageSweeper.consider(snapshot, dispatcher.status())
    },
  })
  bindWatcher(watcher)

  const workspaceOf = (sessionKey: string) => Promise.resolve(hostedStore.snapshotOf(sessionKey as SessionKey)?.workspace ?? null)

  const stage: StageChannelDeps = {
    listRepositories,
    runs,
    dispatcher,
    store: hostedStore,
    launcher: stageLauncher,
    removeWorktree: (path, force) => removeSessionWorktreeAt(platform, { path, force }),
    releaseBranch: (root, branch, baseSha) => releaseStageBranch(platform, { root, branch, baseSha }),
    applyItemAction: actions.applyItemAction,
    snapshot: watcher.snapshot,
    auditDir: userData,
    scratchDir: platform.paths.temp,
    allow: { read: (params) => readAllowBase(platform, params), propose: (request, params) => proposeAllowRule(platform, request, params) },
  }
  const stageSweeper = createStageSweeper(repos.deps, stage, { fetchItemsByNumber: fetchItems, onChange: () => watcher.republish() })

  const update = createDefaultUpdate(platform, restart)

  const seams: AppContext['seams'] = {
    hosting,
    workspace: defaultWorkspaceChannelDeps(userData, workspaceOf, recents),
    stage,
    incidents: { listRepositories, log: incidentLog, chooseSavePath: platform.dialogs.chooseSavePath, writeJson: platform.fs.writeJsonAtomic, now: platform.clock.now },
    // `refresh` is the live watcher's method, never a second poll built here.
    gate: { gatePreflight: actions.gatePreflight, gateAnswer: actions.gateAnswer, refresh: watcher.refresh },
  }

  const live: AppContext['live'] = {
    watcher,
    hostedStore,
    dispatcher,
    stageLauncher,
    offload,
    engine,
    notifier,
    sessionMenu,
    update,
    forceDispatch,
    actions,
    stageSweeper,
    shutdown: () => {
      shutdown()
      void closeOffload()
    },
  }

  void update.service.check('startup')

  return { ...platform, emit, repos, stores: { runStates, sessionIndex, usageLedger, runs, recents, pipelineState, incidentLog }, seams, live }
}
