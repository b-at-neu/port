import { app, BrowserWindow, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS, type IpcChannel, type IpcEvent, type IpcEventMap, type IpcMap } from '../shared/ipc'
import type { WorktreesReport } from '../shared/reclaimer/types'
import type { RepositoryEntry } from '../shared/repos'
import { SOURCE_KINDS } from '../shared/board/types'
import type { BoardSnapshot } from '../shared/board/types'
import { PLAN_GATE_CHOICES } from '../shared/claim/types'
import { OPERATOR_ACTIONS } from '../shared/actions/types'
import type { ItemActionResult } from '../shared/actions/types'
import type { RuntimeProbe } from '../shared/runtime/types'
import { chooseDirectory } from './dialogs'
import { claimApply, claimPreflight, defaultClaimDeps } from './claim'
import type { ClaimDeps } from './claim'
import { applyItemAction, gateAnswer, gateClaimRead, gateClaimSet, gatePreflight } from './actions'
import type { ApplyItemActionParams, ReadyEntry } from './actions'
import { createDispatchRuntime, createDrainStore, defaultHaltDispatchDeps, haltDispatch, resolveDispatchClaimSet, resolveDispatchControl, resolveDispatchRelay } from './dispatch'
import { fetchItemsByNumber } from './github'
import { readGateClaim } from './writes'
import { resolveGateAnswer, resolveGateClaimRead, resolveGateClaimSet, resolveGatePreflight } from './channels/gate'
import type { GateChannelDeps } from './channels/gate'
import { copyRelayReply, MAX_REPLY_CHARS } from './relay'
import { resolveSearchQuery, resolveSessionsScan, resolveTranscriptRead, resolveTranscriptTailClose, resolveTranscriptTailOpen, resolveTranscriptTailPoll } from './channels/sessions'
import {
  defaultHostingChannelDeps,
  resolveSessionAttach,
  resolveSessionCapacity,
  resolveSessionCapacitySet,
  resolveSessionClose,
  resolveSessionDismiss,
  resolveSessionInterrupt,
  resolveSessionInvoke,
  resolveSessionList,
  resolveSessionPermissionAnswer,
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
import { runtimePreflight, runtimeProbe } from './runtime'
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

/** `'claim:preflight'`'s validation: `repoId` must name a currently
 *  registered repository (the same rail `resolveWorktreesReport` already
 *  applies) and `number` a positive integer. */
export async function resolveClaimPreflight(
  registryDeps: RegistryDeps,
  request: IpcMap['claim:preflight']['request'],
  deps: ClaimDeps = defaultClaimDeps,
): ReturnType<typeof claimPreflight> {
  if (typeof request?.repoId !== 'string' || request.repoId === '') {
    throw new Error("'claim:preflight' requires a non-empty 'repoId'")
  }
  if (!Number.isInteger(request.number) || request.number <= 0) {
    throw new Error("'claim:preflight' requires 'number' to be a positive integer")
  }
  return claimPreflight({ registryDeps, repoId: request.repoId, number: request.number }, deps)
}

/** `'claim:apply'`'s validation — the same `repoId`/`number` rail
 *  `resolveClaimPreflight` applies, plus `planGate` restricted to
 *  `PLAN_GATE_CHOICES` and `confirmedAssignees` restricted to an array of
 *  strings: everything a human or the renderer's own state could get wrong
 *  is a thrown error here, never a value `claimApply` has to defend against
 *  (#72's rule). */
export async function resolveClaimApply(
  registryDeps: RegistryDeps,
  request: IpcMap['claim:apply']['request'],
  auditDir: string,
  deps: ClaimDeps = defaultClaimDeps,
): ReturnType<typeof claimApply> {
  if (typeof request?.repoId !== 'string' || request.repoId === '') {
    throw new Error("'claim:apply' requires a non-empty 'repoId'")
  }
  if (!Number.isInteger(request.number) || request.number <= 0) {
    throw new Error("'claim:apply' requires 'number' to be a positive integer")
  }
  if (!(PLAN_GATE_CHOICES as readonly string[]).includes(request.planGate)) {
    throw new Error(`'claim:apply' requires 'planGate' to be one of ${PLAN_GATE_CHOICES.join(', ')}`)
  }
  if (!Array.isArray(request.confirmedAssignees) || !request.confirmedAssignees.every((login) => typeof login === 'string')) {
    throw new Error("'claim:apply' requires 'confirmedAssignees' to be an array of strings")
  }
  return claimApply(
    { registryDeps, repoId: request.repoId, number: request.number, planGate: request.planGate, confirmedAssignees: request.confirmedAssignees, auditDir },
    deps,
  )
}

/** The two calls `'item:action'` composes — the same injectable seam every
 *  other channel's `*Deps` interface gives, so the validation and
 *  registry-lookup branching below is testable without Electron, a real
 *  registry, or a real watcher. `snapshot`/`refresh` are the live watcher's
 *  own methods — never a second poll built here. */
export interface ItemActionDeps {
  readonly listRepositories: typeof listRepositories
  readonly applyItemAction: (params: ApplyItemActionParams) => Promise<ItemActionResult>
  readonly snapshot: () => BoardSnapshot
  readonly refresh: (request: IpcMap['board:refresh']['request']) => Promise<BoardSnapshot>
}

function isReadyEntry(entry: RepositoryEntry): entry is ReadyEntry {
  return 'config' in entry
}

/** `'item:action'`'s validation: `action` restricted to `OPERATOR_ACTIONS`,
 *  `kind` to `'issue' | 'pull-request'`, `number` a positive integer,
 *  `expectedStage` a string or `null`, and `repoId` the same
 *  currently-registered-and-ready rail every other channel applies —
 *  everything a stale renderer could get wrong is a thrown error here,
 *  never a value `applyItemAction` has to defend against. `repository.issues`
 *  is read-your-writes consistent (`query.ts` Decision 2), so an `applied`
 *  outcome is followed by one forced refresh before the response returns —
 *  the row updates immediately rather than after up to 60s. */
export async function resolveItemAction(registryDeps: RegistryDeps, request: IpcMap['item:action']['request'], auditDir: string, deps: ItemActionDeps): Promise<ItemActionResult> {
  if (typeof request?.repoId !== 'string' || request.repoId === '') {
    throw new Error("'item:action' requires a non-empty 'repoId'")
  }
  if (request.kind !== 'issue' && request.kind !== 'pull-request') {
    throw new Error("'item:action' requires 'kind' to be 'issue' or 'pull-request'")
  }
  if (!Number.isInteger(request.number) || request.number <= 0) {
    throw new Error("'item:action' requires 'number' to be a positive integer")
  }
  if (!(OPERATOR_ACTIONS as readonly string[]).includes(request.action)) {
    throw new Error(`'item:action' requires 'action' to be one of ${OPERATOR_ACTIONS.join(', ')}`)
  }
  const expectedStage: unknown = request.expectedStage
  if (expectedStage !== null && (typeof expectedStage !== 'string' || expectedStage === '')) {
    throw new Error("'item:action' requires 'expectedStage' to be a non-empty string or null")
  }

  const list = await deps.listRepositories(registryDeps)
  if (!list.ok) throw new Error(`'item:action' could not list repositories: ${list.message}`)
  const found = list.repositories.find((repository) => repository.id === request.repoId)
  if (!found) throw new Error(`'item:action' found no repository registered with id '${request.repoId}'`)
  if (!isReadyEntry(found)) throw new Error(`'item:action' requires a 'ready' repository, got '${found.problem.kind}'`)

  const result = await deps.applyItemAction({
    request: { repoId: request.repoId, kind: request.kind, number: request.number, action: request.action, expectedStage: request.expectedStage },
    snapshot: deps.snapshot(),
    entry: found,
    auditDir,
  })

  if (result.ok && result.outcome.kind === 'applied') {
    // The write already landed and `result` already reflects it — a failure
    // in this forced refresh (a transient GitHub read error) must never turn
    // into a rejected promise that masks the write's own success, so it is
    // logged and swallowed rather than left to propagate.
    try {
      await deps.refresh({ repoId: request.repoId, source: 'github' })
    } catch (error) {
      console.error(`'item:action' post-write refresh failed for '${request.repoId}':`, error)
    }
  }
  return result
}

/** `'runtime:probe'`'s validation — `runtimeProbe` (`./runtime`) resolves the registry lookup itself, same as `resolveClaimPreflight`/`main/claim.ts`. */
export async function resolveRuntimeProbe(registryDeps: RegistryDeps, request: IpcMap['runtime:probe']['request']): Promise<RuntimeProbe> {
  if (typeof request?.repoId !== 'string' || request.repoId === '') throw new Error("'runtime:probe' requires a non-empty 'repoId'")
  return runtimeProbe({ registryDeps, repoId: request.repoId })
}

export interface RegisteredIpc {
  readonly watcher: PipelineWatcher
  readonly hostedStore: HostedStore
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

  // The app-wide drain switch (#110) — one store for the process lifetime,
  // read fresh by every `buildSnapshot()` so a drain applied mid-session is
  // visible on the very next snapshot. `load()` resolves the on-disk state
  // asynchronously; `current()` stays synchronous and starts `unread` so
  // `registerIpc()` itself never blocks on it.
  const drain = createDrainStore(app.getPath('userData'))
  void drain.load()

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

  // #265: the ledger, streak memo, and dispatcher, bundled — see
  // `main/dispatch/runtime.ts` for why `bindWatcher` exists.
  const { ledger: dispatchLedger, unknownStreaks, dispatcher, bindWatcher } = createDispatchRuntime({
    store: hostedStore,
    drain: drain.current,
    readGateClaim,
    fetchItemsByNumber,
    listRepositories,
    registryDeps,
    now: () => new Date(),
  })

  // The board's own clock (#80) — one watcher for the process lifetime,
  // broadcasting every snapshot over `board:update`. #265: `onSnapshot` also
  // hands the snapshot to the dispatcher, never awaited — a dispatch pass
  // must never block the broadcast the renderer is waiting on.
  const watcher = createPipelineWatcher({
    repositories: async () => {
      const list = await listRepositories(registryDeps)
      return list.ok ? list.repositories : []
    },
    git: (args, cwd) => git(args, { cwd }),
    drain: drain.current,
    ledger: dispatchLedger,
    unknownStreaks,
    dispatchStatus: () => dispatcher.status(),
    onSnapshot: (snapshot) => {
      broadcast('board:update', snapshot)
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

  handle('item:action', (_event, request) =>
    resolveItemAction(registryDeps, request, app.getPath('userData'), { listRepositories, applyItemAction, snapshot: watcher.snapshot, refresh: watcher.refresh }),
  )

  // Operator control over dispatch (#110) — all branching in
  // `resolveDispatchControl` itself. #265: `halt` also stops this app's own
  // dispatched agents first; `stopFor` is a no-op for anything else.
  handle('dispatch:control', (_event, request) =>
    resolveDispatchControl(registryDeps, request, {
      listRepositories,
      drain,
      haltDispatch: (params) => haltDispatch(params, { ...defaultHaltDispatchDeps, stopFor: (repoId, number) => dispatcher.stopFor(repoId, number) }),
      snapshot: watcher.snapshot,
      refresh: watcher.refresh,
      auditDir: app.getPath('userData'),
      now: () => new Date(),
    }),
  )

  // #265: the dispatch claim take/release and the "Send to agent" relay —
  // both delegate to the one dispatcher instance above.
  handle('dispatch:claim:set', (_event, request) => resolveDispatchClaimSet(registryDeps, request, { listRepositories, dispatcher, refresh: watcher.refresh, now: () => new Date() }))

  handle('dispatch:relay', (_event, request) => resolveDispatchRelay(registryDeps, request, { listRepositories, dispatcher, maxReplyChars: MAX_REPLY_CHARS }))

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

  return { watcher, hostedStore }
}
