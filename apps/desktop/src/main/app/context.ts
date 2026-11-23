// The composition root: everything an action may touch, built once at startup in today's construction order.
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { EventMap, EventName } from '@/main/app/events'
import { chooseDirectory, chooseSavePath } from '@/main/app/shell/dialogs'
import { createIncidentLog } from '@/main/pipeline/incidents/log'
import { defaultWorkspaceChannelDeps } from '@/main/features/folders/resolve'
import { createRecentsStore } from '@/main/features/folders/recents'
import { createSessionWorktree, removeSessionWorktreeAt } from '@/main/repos/worktree/worktree'
import { releaseStageBranch } from '@/main/repos/worktree/stage-worktree'
import { createDefaultStageLauncher } from '@/main/dispatch/stage/default'
import { createOffload } from '@/main/worker/deps'
import { statPath, readJsonFile, writeJsonFileAtomic } from '@/main/platform/files'
import { bindOperator } from '@/main/app/operator'
import { createPipelineState } from '@/main/pipeline/state/default'
import { defaultHostingChannelDeps } from '@/main/features/session/resolve'
import { createDispatchRuntime } from '@/main/dispatch/runtime'
import { createRunStateStore } from '@/main/dispatch/store'
import { registeredRepoIds } from '@/main/dispatch/resolve'
import { fetchItemsByNumber } from '@/main/github/adapter'
import { readOwnership, takeOwnership } from '@/main/repos/ownership'
import type { GateChannelDeps, HostingChannelDeps, IncidentChannelDeps, StageChannelDeps } from '@/main/app/seams'
import { defaultGitRunner, git } from '@/main/platform/git'
import { listRepositories } from '@/main/repos'
import type { RegistryDeps } from '@/types/registry'
import { createPipelineWatcher } from '@/main/pipeline/board/watcher'
import { createHostedStore, defaultHostedStoreDeps } from '@/main/sessions/hosting/store'
import { createHostingPersistence } from '@/main/sessions/hosting/persist'
import { createSessionIndex } from '@/main/sessions/hosting/session-index'
import { createAppNotifier } from '@/main/sessions/hosting/notify'
import { createStageRegistry } from '@/main/dispatch/stage/registry'
import { createStageSweeper, defaultAllowIo } from '@/main/features/stage/resolve'
import { createUsageLedger } from '@/main/sessions/hosting/usage-ledger'
import { createSessionMenuRefresher } from '@/main/app/shell/session-menu'
import { createDefaultUpdate } from '@/main/features/update/default'
import type { RestartSeams } from '@/types/update'
import type { Dispatcher, RunStateStore } from '@/types/dispatch'
import type { HostedStore } from '@/types/hosting'
import type { PipelineWatcher } from '@/types/state'
import type { ForceDispatch } from '@/types/tick'
import type { SessionIndex } from '@/types/session-index'
import type { StageLauncherHandle, StageRegistry } from '@/types/stage'
import type { IncidentLog } from '@/types/incidents'
import type { RecentsStore } from '@/types/workspace'
import type { UsageLedger, AppInfo } from '@/types/settings'
import type { WorkspaceChannelDeps } from '@/main/features/folders/resolve'
import type { SessionKey } from '@/types/hosting'
import type { AppCommand } from '@/utils/shell/commands'

type Offload = ReturnType<typeof createOffload>

export interface AppContext {
  readonly paths: { readonly userData: string; readonly temp: string; readonly logs: string }
  readonly info: () => AppInfo
  /** The one broadcast to every renderer window. */
  readonly emit: <E extends EventName>(event: E, payload: EventMap[E]) => void
  readonly repos: { readonly deps: RegistryDeps; readonly list: (options?: { readonly fresh?: boolean }) => ReturnType<typeof listRepositories> }
  readonly stores: {
    readonly runStates: RunStateStore
    readonly sessionIndex: SessionIndex
    readonly usageLedger: UsageLedger
    readonly stageRegistry: StageRegistry
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
  const registryDeps: RegistryDeps = { registryDir: userData, git: (args, cwd) => git(args, { cwd }), chooseDirectory }

  const runStates = createRunStateStore(userData)
  void runStates.load(() => registeredRepoIds(registryDeps))

  const { engine, close: closeOffload, ...offload } = createOffload({ onRespawn: () => void watcher.refresh() })

  const recents = createRecentsStore({ dir: userData })

  const notifier = createAppNotifier({ registryDeps, broadcast: (command) => emit('app.command', command), prefs: () => hostedStore.notificationPrefs() })

  // Assigned right after createDispatchRuntime below — stageLauncher's onOutcome closes over it, so construction order stays acyclic.
  let dispatcherRef: Dispatcher | null = null

  const incidentLog = createIncidentLog({ dir: userData, now: () => new Date(), newId: () => globalThis.crypto.randomUUID() })
  const pipelineState = createPipelineState({ dir: userData, auditDir: userData, recordIncident: incidentLog.record })
  const actions = bindOperator(pipelineState)

  // Loaded once at boot: a `running` entry found then can only mean the process died, and promotes to `crash`.
  const stageRegistry = createStageRegistry({ path: join(userData, 'stage-sessions.json'), readJson: readJsonFile, writeJsonAtomic: writeJsonFileAtomic, now: () => new Date() })
  void stageRegistry.load()

  const sessionIndex = createSessionIndex({ path: join(userData, 'session-index.json'), readJson: readJsonFile, writeJsonAtomic: writeJsonFileAtomic, now: () => new Date() })
  void sessionIndex.load()

  const usageLedger = createUsageLedger({ path: join(userData, 'usage-ledger.json'), readJson: readJsonFile, writeJsonAtomic: writeJsonFileAtomic, now: () => new Date(), bootId: globalThis.crypto.randomUUID() })
  void usageLedger.load()

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
    registry: stageRegistry,
    onOutcome: (repoId, sessionKey, outcome, plan) => dispatcherRef?.recordOutcome(repoId, sessionKey, outcome, plan),
    onResumedTurn: (repoId, sessionKey) => dispatcherRef?.recordResumedTurn(repoId, sessionKey),
    onResumed: (repoId, sessionKey, entry) => dispatcherRef?.trackResumed(repoId, sessionKey, entry),
    onDenial: (repoId, denial) => dispatcherRef?.recordDenial(repoId, denial),
    bundle: { isPackaged: app.isPackaged, mainDir: __dirname, resourcesPath: process.resourcesPath },
  })
  const hosting = defaultHostingChannelDeps(hostedStore, sessionIndex, {
    git: (args, cwd) => git(args, { cwd }),
    recents,
    exists: async (path) => (await statPath(path)).ok,
    readSessions: () => engine.listSessions(),
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
    actions,
    stateLabels: pipelineState.stateLabels,
    dirs: { audit: userData, scratch: app.getPath('temp') },
    now: () => new Date(),
    recordIncident: incidentLog.record,
    interrupted: (repoId) => stageRegistry.list().filter((entry) => entry.repoId === repoId),
  })
  dispatcherRef = dispatcher

  // One watcher for the process lifetime. `onTick` fires only on a fresh poll, never awaited.
  const watcher = createPipelineWatcher({
    engine,
    repositories: async ({ fresh }) => {
      const list = await listRepositories(registryDeps, { fresh })
      return list.ok ? list.repositories : []
    },
    git: (args, cwd) => git(args, { cwd }),
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
    registry: stageRegistry,
    dispatcher,
    store: hostedStore,
    launcher: stageLauncher,
    removeWorktree: (path, force) => removeSessionWorktreeAt({ path, force, git: defaultGitRunner() }),
    releaseBranch: (root, branch, baseSha) => releaseStageBranch({ root, git: defaultGitRunner(), branch, baseSha }),
    applyItemAction: actions.applyItemAction,
    snapshot: watcher.snapshot,
    auditDir: userData,
    scratchDir: app.getPath('temp'),
    allow: defaultAllowIo,
  }
  const stageSweeper = createStageSweeper(registryDeps, stage, { fetchItemsByNumber, onChange: () => watcher.republish() })

  const update = createDefaultUpdate(restart)
  void update.service.check('startup')

  return {
    paths: { userData, temp: app.getPath('temp'), logs: app.getPath('logs') },
    info: () => ({ app: app.getVersion(), electron: process.versions.electron, node: process.versions.node, chromium: process.versions.chrome, commit: __PORT_BUILD_COMMIT__ }),
    emit,
    repos: { deps: registryDeps, list: (options) => listRepositories(registryDeps, options) },
    stores: { runStates, sessionIndex, usageLedger, stageRegistry, recents, pipelineState, incidentLog },
    live: {
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
    },
    seams: {
      hosting,
      workspace: defaultWorkspaceChannelDeps(userData, workspaceOf, recents),
      stage,
      incidents: { listRepositories, log: incidentLog, chooseSavePath, writeJson: writeJsonFileAtomic, now: () => new Date() },
      // `refresh` is the live watcher's method, never a second poll built here.
      gate: { gatePreflight: actions.gatePreflight, gateAnswer: actions.gateAnswer, refresh: watcher.refresh },
    },
  }
}
