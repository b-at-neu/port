import { app, BrowserWindow, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS, type IpcChannel, type IpcEvent, type IpcEventMap, type IpcMap } from '../shared/ipc'
import type { WorktreesReport } from '../shared/reclaimer/types'
import { SOURCE_KINDS } from '../shared/board/types'
import type { BoardSnapshot } from '../shared/board/types'
import { chooseDirectory } from './dialogs'
import { applyItemAction, applyItemDecision, gateAnswer, gateClaimRead, gateClaimSet, gatePreflight } from './actions'
import { resolveClaimApply, resolveClaimPreflight } from './channels/claim'
import { resolveBacklogList } from './channels/backlog'
import { resolveGhStatus } from './channels/gh'
import { createDispatchRuntime, createRunStateStore, defaultHaltDispatchDeps, haltDispatch, registeredRepoIds, resolveDispatchClaimSet, resolveDispatchControl, resolveDispatchRelay } from './dispatch'
import type { Dispatcher } from './dispatch'
import { fetchItemsByNumber } from './github'
import { readGateClaim } from './writes'
import { resolveGateAnswer, resolveGateClaimRead, resolveGateClaimSet, resolveGatePreflight } from './channels/gate'
import type { GateChannelDeps } from './channels/gate'
import { resolveItemAction, resolveItemDecision } from './channels/items'
import type { ItemDecisionDeps } from './channels/items'
import { resolveRuntimeProbe } from './channels/runtime'
import { copyRelayReply } from './relay'
import { resolveSearchQuery, resolveSessionsScan, resolveTranscriptRead, resolveTranscriptTailClose, resolveTranscriptTailOpen, resolveTranscriptTailPoll } from './channels/sessions'
import {
  defaultHostingChannelDeps,
  resolveSessionAttach,
  resolveSessionCapacity,
  resolveSessionCapacitySet,
  resolveSessionClose,
  resolveSessionDefaults,
  resolveSessionDefaultsSet,
  resolveSessionDismiss,
  resolveSessionInterrupt,
  resolveSessionInvoke,
  resolveSessionList,
  resolveSessionPermissionAnswer,
  resolveSessionRename,
  resolveSessionRestore,
  resolveSessionRestoreDiscard,
  resolveSessionRestoreList,
  resolveSessionSend,
  resolveSessionStart,
} from './channels/hosting'
import { git } from './platform'
import { readWorktreeReport } from './reclaimer'
import type { ReadWorktreeReportParams } from './reclaimer'
import { addRepository, listRepositories, removeRepository } from './registry'
import type { RegistryDeps } from './registry'
import { createPipelineWatcher } from './state'
import type { PipelineWatcher } from './state'
import { runtimePreflight } from './runtime'
import { createHostedStore, createHostingPersistence, defaultHostedStoreDeps } from './hosting'
import type { HostedStore } from './hosting'

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

/** The one place every main → renderer push goes through (#219) — a net
 *  line reduction over each caller repeating its own `for (const window of
 *  BrowserWindow.getAllWindows())` loop, and one seam if a future push ever
 *  needs anything beyond "every open, non-destroyed window". */
function broadcast<E extends IpcEvent>(event: E, payload: IpcEventMap[E]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(event, payload)
  }
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

/** The two calls `'board:refresh'` composes — the same injectable seam
 *  `WorktreesReportDeps` gives `resolveWorktreesReport`, so the id/source
 *  validation below is testable without Electron or a real watcher. */
export interface BoardRefreshDeps {
  readonly listRepositories: typeof listRepositories
  readonly refresh: (request: IpcMap['board:refresh']['request']) => Promise<BoardSnapshot>
}

/** `repoId`, when present, must name a currently registered repository —
 *  the same rail `resolveWorktreesReport` already applies — and `source`
 *  must be one of `SOURCE_KINDS`; anything else throws rather than silently
 *  forcing nothing. */
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
  // The one place a real `git` invocation and the real userData directory
  // reach the registry — every registry function itself takes these as
  // injected dependencies, so its own tests need neither Electron nor a
  // real repository.
  const registryDeps: RegistryDeps = {
    registryDir: app.getPath('userData'),
    git: (args, cwd) => git(args, { cwd }),
    chooseDirectory,
  }

  // #314: the per-repository run-state store, created before `repos:add`/
  // `repos:remove` so their handlers can forget a stale entry; `current()`
  // stays synchronous and starts every repository paused.
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

  // #314: forgetting a run-state entry never fails the registry call itself,
  // only logs — so a stale entry can never silently revive a re-added repo.
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

  handle('sessions:scan', (_event, request) => {
    if (request !== undefined) {
      throw new Error("'sessions:scan' takes no payload")
    }
    return resolveSessionsScan(registryDeps)
  })

  handle('transcript:read', (_event, request) => resolveTranscriptRead(request))

  handle('transcript:tail:open', (_event, request) => resolveTranscriptTailOpen(request))

  handle('transcript:tail:poll', (_event, request) => resolveTranscriptTailPoll(request))

  handle('transcript:tail:close', (_event, request) => resolveTranscriptTailClose(request))

  handle('search:query', (_event, request) => resolveSearchQuery(registryDeps, request, app.getPath('userData')))

  // #98: one hosted-session store for the process lifetime, broadcasting
  // over `session:event`/`session:status`. Created before the watcher
  // (#265): the dispatcher sits between the two and needs this store first.
  const hostedStore = createHostedStore({
    ...defaultHostedStoreDeps,
    onEvent: (envelope) => broadcast('session:event', envelope),
    onStatus: (snapshot) => broadcast('session:status', snapshot),
    onEntries: (delta) => broadcast('session:entries', delta),
    persistence: createHostingPersistence({ dir: app.getPath('userData') }),
  })
  const hostingChannelDeps = defaultHostingChannelDeps(hostedStore)

  // #326: the ledger, refresh memo, and dispatch loop, bundled — see
  // `main/dispatch/runtime.ts` for why `bindWatcher` exists. `launch: null`
  // is the honest state until #327 passes a real `StageLauncher` — a
  // candidate sits visibly at `no-launcher` rather than silently idle.
  const { watcherDeps, dispatcher, bindWatcher, shutdown } = createDispatchRuntime({
    store: hostedStore,
    launch: null,
    runState: (repoId) => runStates.current(repoId).state,
    readGateClaim,
    fetchItemsByNumber,
    listRepositories,
    registryDeps,
    dirs: { audit: app.getPath('userData'), scratch: app.getPath('temp') },
    now: () => new Date(),
  })

  // The board's own clock (#80) — one watcher for the process lifetime,
  // broadcasting every snapshot over `board:update`. #326: `onTick` fires
  // only on a fresh poll (never on `republish()`), considering the dispatch
  // loop against it, never awaited — a pass must never block the broadcast
  // the renderer is waiting on.
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

  // Operator control over dispatch (#110, #314): run/drain/pause one
  // repository, or halt everything — all branching in `resolveDispatchControl`.
  handle('dispatch:control', (_event, request) =>
    resolveDispatchControl(registryDeps, request, {
      listRepositories,
      runStates,
      haltDispatch: (params) =>
        haltDispatch(params, { ...defaultHaltDispatchDeps, stopFor: (repoId, number) => dispatcher.stopFor(repoId, number), standDown: (repoId) => dispatcher.standDown(repoId) }),
      snapshot: watcher.snapshot,
      refresh: watcher.refresh,
      auditDir: app.getPath('userData'),
      now: () => new Date(),
    }),
  )

  // #265: the dispatch claim take/release — delegates to the one dispatcher
  // instance above. #326: 'dispatch:relay' is removed along with the hosted
  // dispatcher session it relayed through.
  handle('dispatch:claim:set', (_event, request) => resolveDispatchClaimSet(registryDeps, request, { listRepositories, dispatcher, refresh: watcher.refresh, now: () => new Date() }))

  handle('runtime:preflight', (_event, request) => {
    if (request !== undefined) throw new Error("'runtime:preflight' takes no payload")
    return runtimePreflight()
  })

  handle('runtime:probe', (_event, request) => resolveRuntimeProbe(registryDeps, request))

  // The plan gate's four channels (#92) — `gatePreflight`/`gateClaimRead`/
  // `gateClaimSet`/`gateAnswer` are `main/actions/gate.ts`'s own exports,
  // already bound to their own `defaultGateDeps`; `refresh` is the live
  // watcher's method, never a second poll built here.
  const gateChannelDeps: GateChannelDeps = { gatePreflight, gateClaimRead, gateClaimSet, gateAnswer, refresh: watcher.refresh }

  handle('gate:preflight', (_event, request) => resolveGatePreflight(registryDeps, request, gateChannelDeps))

  handle('gate:claim:read', (_event, request) => resolveGateClaimRead(registryDeps, request, gateChannelDeps))

  handle('gate:claim:set', (_event, request) => resolveGateClaimSet(registryDeps, request, gateChannelDeps))

  handle('gate:answer', (_event, request) => resolveGateAnswer(registryDeps, request, app.getPath('userData'), app.getPath('temp'), gateChannelDeps))

  // The relay loop's own copy button (#107) — one delegating line;
  // `copyRelayReply` (`./relay`) does the validation and the one electron
  // clipboard write.
  handle('relay:copy', (_event, request) => copyRelayReply(request))

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

  for (const channel of IPC_CHANNELS) {
    if (!registered.has(channel)) {
      throw new Error(`IPC channel '${channel}' is declared but has no handler`)
    }
  }

  return { watcher, hostedStore, dispatcher, shutdownDispatch: shutdown }
}
