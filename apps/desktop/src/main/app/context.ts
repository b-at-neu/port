// The composition root: everything an action may touch, built once at startup, one block per service.
import { app, BrowserWindow, session, shell } from 'electron'
import { join } from 'node:path'
import type { EventMap, EventName } from '@/main/app/events'
import { chooseDirectory, chooseFolder, chooseSavePath } from '@/main/app/shell/dialogs'
import { createIncidentLog } from '@/main/pipeline/incidents/log'
import { createRunStateStore } from '@/main/pipeline/state/run-state'
import { createRunStore } from '@/main/pipeline/state/run-store'
import { createPipelineStateStore, PIPELINE_STATE_FILE } from '@/main/pipeline/state/store'
import { pathOps } from '@/main/platform/paths'
import { createRecentsStore } from '@/main/features/folders/recents'
import { createForceDispatch, createRefreshMemo, createRerunMemo, createUnknownStreaks } from '@/main/pipeline/tick/ledger'
import type { PipelineMemos } from '@/main/pipeline/context'
import { createWorkerEngine } from '@/main/worker/client'
import { createAutoPlanner } from '@/main/dispatch/auto-plan'
import { createDispatcher } from '@/main/dispatch/dispatcher'
import { stageBundleRoot } from '@/main/dispatch/stage/bundle'
import { createStageLauncher } from '@/main/dispatch/stage/launcher'
import { createInterruptedSweeper } from '@/main/dispatch/stage/sweep'
import type { StateEngine } from '@/types/offload'
import { createPlatform, type Platform } from '@/main/platform'
import { nativeNotify } from '@/main/platform/notify'
import { createRepos, type Repos } from '@/main/repos'
import { createPipelineWatcher } from '@/main/pipeline/board/watcher'
import { createHostedStore } from '@/main/sessions/hosting/store'
import { createHostingPersistence } from '@/main/sessions/hosting/persist'
import { createSessionIndex } from '@/main/sessions/hosting/session-index'
import { createNotifier } from '@/main/sessions/hosting/notify'
import { createUsageLedger } from '@/main/sessions/hosting/usage-ledger'
import { createSessionMenuRefresher } from '@/main/app/shell/session-menu'
import { createUpdate } from '@/main/features/update/create'
import { createFileDownloader } from '@/main/platform/download'
import { createNativeUpdater } from '@/main/platform/native-updater'
import type { RestartSeams } from '@/types/update'
import type { AutoPlanner, Dispatcher, RunStateStore } from '@/types/dispatch'
import type { HostedStore } from '@/types/hosting'
import type { PipelineStateStore } from '@/types/pipeline-state'
import type { PipelineWatcher } from '@/types/state'
import type { SessionIndex } from '@/types/session-index'
import type { RunStore, StageLauncherHandle } from '@/types/stage'
import type { IncidentLog } from '@/types/incidents'
import type { RecentsStore } from '@/types/workspace'
import type { UsageLedger } from '@/types/settings'
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
    readonly engine: StateEngine
    readonly notifier: ReturnType<typeof createNotifier>
    readonly sessionMenu: ReturnType<typeof createSessionMenuRefresher>
    readonly update: ReturnType<typeof createUpdate>
    readonly autoPlanner: AutoPlanner
    readonly memos: PipelineMemos
    readonly stageSweeper: ReturnType<typeof createInterruptedSweeper>
    /** Stops the dispatcher and closes the worker. */
    readonly shutdown: () => void
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
    updates: {
      isPackaged: app.isPackaged,
      installHost: { platform: process.platform, arch: process.arch, appImage: process.env['APPIMAGE'], arm64Translation: app.runningUnderARM64Translation },
      downloadsDir: () => app.getPath('downloads'),
      download: (request) => createFileDownloader(session.defaultSession)(request),
      open: (path) => shell.openPath(path),
      reveal: (path) => shell.showItemInFolder(path),
      native: createNativeUpdater,
    },
  })
  const repos = createRepos(platform)

  const recents = createRecentsStore(platform, { dir: userData })

  const incidentLog = createIncidentLog(platform)

  // Loading it once at boot marks every run a lost process left open `crash`.
  const pipelineState = createPipelineStateStore(platform)
  const runs = createRunStore({ store: pipelineState, newId: () => globalThis.crypto.randomUUID(), now: platform.clock.now })
  const runStates = createRunStateStore(pipelineState, pathOps.join(userData, PIPELINE_STATE_FILE))

  const sessionIndex = createSessionIndex({ path: join(userData, 'session-index.json'), readJson: platform.fs.readJson, writeJsonAtomic: platform.fs.writeJsonAtomic, now: platform.clock.now })
  void sessionIndex.load()

  const usageLedger = createUsageLedger({ path: join(userData, 'usage-ledger.json'), readJson: platform.fs.readJson, writeJsonAtomic: platform.fs.writeJsonAtomic, now: platform.clock.now, bootId: globalThis.crypto.randomUUID() })
  void usageLedger.load()

  // `live` is assigned once every service exists; a read before then is a construction-order bug.
  let live: AppContext['live'] | null = null
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
  }

  const { close: closeOffload, ...engine } = createWorkerEngine(platform, { onRespawn: () => void ctx.live.watcher.refresh() })

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
  const memos: PipelineMemos = { unknownStreaks: createUnknownStreaks(), refreshMemo: createRefreshMemo(), rerunMemo: createRerunMemo(), forceDispatch: createForceDispatch() }
  const stageLauncher = createStageLauncher(ctx, stageBundleRoot({ isPackaged: app.isPackaged, mainDir: __dirname, resourcesPath: process.resourcesPath }))
  const dispatcher = createDispatcher(ctx)
  const autoPlanner = createAutoPlanner(ctx)
  const stageSweeper = createInterruptedSweeper(ctx)

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

  const update = createUpdate(platform, restart)

  live = {
    watcher,
    hostedStore,
    dispatcher,
    stageLauncher,
    engine,
    notifier,
    sessionMenu,
    update,
    autoPlanner,
    memos,
    stageSweeper,
    shutdown: () => {
      dispatcher.shutdown()
      void closeOffload()
    },
  }

  void update.service.check('startup')

  return ctx
}
