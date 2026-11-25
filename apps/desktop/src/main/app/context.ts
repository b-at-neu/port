// The composition root: everything an action may touch, built once at startup, one block per service.
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { EventMap, EventName } from '@/main/app/events'
import { chooseDirectory, chooseFolder, chooseSavePath } from '@/main/app/shell/dialogs'
import { createIncidentLog } from '@/main/pipeline/incidents/log'
import { createRunStateStore } from '@/main/pipeline/state/run-state'
import { createRunStore } from '@/main/pipeline/state/run-store'
import { createPipelineStateStore, PIPELINE_STATE_FILE } from '@/main/pipeline/state/store'
import { pathOps } from '@/main/platform/paths'
import { defaultWorkspaceChannelDeps } from '@/main/features/folders/resolve'
import { createRecentsStore } from '@/main/features/folders/recents'
import { removeSessionWorktreeAt } from '@/main/repos/worktree/worktree'
import { releaseStageBranch } from '@/main/repos/worktree/stage-worktree'
import { createDefaultStageLauncher } from '@/main/dispatch/stage/default'
import { createWorkerEngine } from '@/main/worker/client'
import { resolveSessionsScan } from '@/main/features/history/resolve'
import { bindOperator } from '@/main/app/operator'
import { defaultHostingChannelDeps } from '@/main/features/session/resolve'
import { createDispatchRuntime } from '@/main/dispatch/runtime'
import { fetchItemsByNumber } from '@/main/github/tracker/items'
import { readAllowBase } from '@/main/github/allow'
import { proposeAllowRule } from '@/main/github/writes/allow'
import type { FetchItemsByNumberParams } from '@/types/github'
import { readOwnership, takeOwnership } from '@/main/repos/ownership'
import type { HostingChannelDeps, SearchQueryDeps, SessionsScanDeps, StageChannelDeps, TranscriptTailDeps } from '@/main/app/seams'
import type { StateEngine } from '@/types/offload'
import { createPlatform, type Platform } from '@/main/platform'
import { nativeNotify } from '@/main/platform/notify'
import { createRepos, listRepositories, type Repos } from '@/main/repos'
import { createPipelineWatcher } from '@/main/pipeline/board/watcher'
import { createHostedStore } from '@/main/sessions/hosting/store'
import { createHostingPersistence } from '@/main/sessions/hosting/persist'
import { createSessionIndex } from '@/main/sessions/hosting/session-index'
import { createNotifier } from '@/main/sessions/hosting/notify'
import { createStageSweeper } from '@/main/features/stage/resolve'
import { createUsageLedger } from '@/main/sessions/hosting/usage-ledger'
import { createSessionMenuRefresher } from '@/main/app/shell/session-menu'
import { createDefaultUpdate } from '@/main/features/update/default'
import type { RestartSeams } from '@/types/update'
import type { AutoPlanner, Dispatcher, OwnershipParams, RunStateStore } from '@/types/dispatch'
import type { HostedStore } from '@/types/hosting'
import type { PipelineStateStore } from '@/types/pipeline-state'
import type { PipelineWatcher } from '@/types/state'
import type { ForceDispatch, RefreshMemo, RerunMemo, UnknownStreaks } from '@/types/tick'
import type { SessionIndex } from '@/types/session-index'
import type { RunStore, StageLauncherHandle } from '@/types/stage'
import type { IncidentLog } from '@/types/incidents'
import type { RecentsStore } from '@/types/workspace'
import type { UsageLedger } from '@/types/settings'
import type { WorkspaceChannelDeps } from '@/main/features/folders/resolve'
import type { SessionKey } from '@/types/hosting'
import type { AppCommand } from '@/utils/shell/commands'

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
    readonly pipelineState: PipelineStateStore
    readonly incidentLog: IncidentLog
  }
  readonly live: {
    readonly watcher: PipelineWatcher
    readonly hostedStore: HostedStore
    readonly dispatcher: Dispatcher
    readonly stageLauncher: StageLauncherHandle
    readonly offload: { readonly sessionsScan: SessionsScanDeps; readonly search: SearchQueryDeps; readonly tail: TranscriptTailDeps }
    readonly engine: StateEngine
    readonly notifier: ReturnType<typeof createNotifier>
    readonly sessionMenu: ReturnType<typeof createSessionMenuRefresher>
    readonly update: ReturnType<typeof createDefaultUpdate>
    readonly forceDispatch: ForceDispatch
    readonly autoPlanner: AutoPlanner
    readonly memos: { readonly unknownStreaks: UnknownStreaks; readonly refreshMemo: RefreshMemo; readonly rerunMemo: RerunMemo }
    readonly actions: ReturnType<typeof bindOperator>
    readonly stageSweeper: ReturnType<typeof createStageSweeper>
    /** Stops the dispatcher and closes the worker. */
    readonly shutdown: () => void
  }
  readonly seams: {
    readonly hosting: HostingChannelDeps
    readonly workspace: WorkspaceChannelDeps
    readonly stage: StageChannelDeps
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

  const incidentLog = createIncidentLog(platform)

  const ownership = {
    read: (params: OwnershipParams) => readOwnership(platform, params),
    take: (params: OwnershipParams) => takeOwnership(platform, params),
  }

  const fetchItems = (params: FetchItemsByNumberParams) => fetchItemsByNumber(platform, params)

  // Loading it once at boot marks every run a lost process left open `crash`.
  const pipelineState = createPipelineStateStore(platform)
  const runs = createRunStore({ store: pipelineState, newId: () => globalThis.crypto.randomUUID(), now: platform.clock.now })
  const runStates = createRunStateStore(pipelineState, pathOps.join(userData, PIPELINE_STATE_FILE))

  const sessionIndex = createSessionIndex({ path: join(userData, 'session-index.json'), readJson: platform.fs.readJson, writeJsonAtomic: platform.fs.writeJsonAtomic, now: platform.clock.now })
  void sessionIndex.load()

  const usageLedger = createUsageLedger({ path: join(userData, 'usage-ledger.json'), readJson: platform.fs.readJson, writeJsonAtomic: platform.fs.writeJsonAtomic, now: platform.clock.now, bootId: globalThis.crypto.randomUUID() })
  void usageLedger.load()

  // `live` and `seams` are assigned once every service exists; a read before then is a construction-order bug.
  let live: AppContext['live'] | null = null
  let seams: AppContext['seams'] | null = null
  const stores: AppContext['stores'] = { runStates, sessionIndex, usageLedger, runs, recents, pipelineState, incidentLog }
  const ctx: AppContext = {
    ...platform,
    emit,
    repos,
    stores,
    get live() {
      if (live === null) throw new Error('ctx.live read during construction')
      return live
    },
    get seams() {
      if (seams === null) throw new Error('ctx.seams read during construction')
      return seams
    },
  }

  const { close: closeOffload, ...engine } = createWorkerEngine(platform, { onRespawn: () => void ctx.live.watcher.refresh() })
  const sessionsScan: SessionsScanDeps = { listRepositories, readSessionState: ({ repos: scanRepos }) => engine.scanSessions({ repos: scanRepos }) }
  const offload: AppContext['live']['offload'] = {
    sessionsScan,
    search: {
      resolveSessionsScan: (registryDeps) => resolveSessionsScan(registryDeps, sessionsScan),
      runSearch: ({ scan, indexDir, query, scope }) => engine.search({ scan, indexDir, query, scope }),
    },
    tail: {
      openTail: (params) => engine.tailOpen(params),
      pollTail: (params) => engine.tailPoll(params),
      closeTail: (params) => void engine.tailClose(params),
    },
  }

  const actions = bindOperator(ctx)

  const notifier = createNotifier({ notify: platform.notify, repos, emit }, () => hostedStore.notificationPrefs())

  const hostedStore = createHostedStore(platform, {
    listSessions: () => engine.listSessions(),
    persistence: createHostingPersistence({ dir: userData }),
    onStatus: (snapshot) => {
      emit('session.status', snapshot)
      sessionIndex.observe(snapshot)
      usageLedger.observe(snapshot)
      notifier.observe(snapshot)
      stageLauncher.observe(snapshot)
      sessionMenu.refresh()
    },
    onEntries: (delta) => emit('session.entries', delta),
  })
  const sessionMenu = createSessionMenuRefresher({ emit }, hostedStore)
  const stageLauncher: StageLauncherHandle = createDefaultStageLauncher({
    store: hostedStore,
    runs,
    onOutcome: (repoId, sessionKey, outcome, plan) => ctx.live.dispatcher.recordOutcome(repoId, sessionKey, outcome, plan),
    onResumedTurn: (repoId, sessionKey) => ctx.live.dispatcher.recordResumedTurn(repoId, sessionKey),
    bundle: { isPackaged: app.isPackaged, mainDir: __dirname, resourcesPath: process.resourcesPath },
    userData,
  })
  const hosting = defaultHostingChannelDeps(hostedStore, sessionIndex, { ctx: platform, recents, readSessions: () => engine.listSessions() })

  const { unknownStreaks, refreshMemo, rerunMemo, dispatcher, forceDispatch, autoPlanner, bindWatcher, shutdown } = createDispatchRuntime({
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
    stateLabels: actions.stateLabels,
    dirs: { audit: userData, scratch: platform.paths.temp },
    now: platform.clock.now,
    recordIncident: incidentLog.record,
  })

  // One watcher for the process lifetime. `onTick` fires only on a fresh poll, never awaited.
  const watcher = createPipelineWatcher(ctx, {
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

  seams = {
    hosting,
    workspace: defaultWorkspaceChannelDeps(userData, workspaceOf, recents),
    stage,
  }

  live = {
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
    autoPlanner,
    memos: { unknownStreaks, refreshMemo, rerunMemo },
    actions,
    stageSweeper,
    shutdown: () => {
      shutdown()
      void closeOffload()
    },
  }

  void update.service.check('startup')

  return ctx
}
