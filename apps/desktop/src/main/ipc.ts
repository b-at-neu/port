import { app, BrowserWindow, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS, type IpcChannel, type IpcMap } from '../shared/ipc'
import type { WorktreesReport } from '../shared/reclaimer/types'
import type { RepositoryEntry } from '../shared/repos'
import type { SessionScan } from '../shared/sessions/types'
import type { TranscriptRead, TranscriptTailOpen, TranscriptTailPoll } from '../shared/sessions/transcript'
import type { SearchResult, SearchScope } from '../shared/search/types'
import { SOURCE_KINDS } from '../shared/board/types'
import type { BoardSnapshot } from '../shared/board/types'
import { PLAN_GATE_CHOICES } from '../shared/claim/types'
import { OPERATOR_ACTIONS } from '../shared/actions/types'
import type { ItemActionResult } from '../shared/actions/types'
import { chooseDirectory } from './dialogs'
import { claimApply, claimPreflight, defaultClaimDeps } from './claim'
import type { ClaimDeps } from './claim'
import { applyItemAction } from './actions'
import type { ApplyItemActionParams, ReadyEntry } from './actions'
import { git } from './platform'
import { readWorktreeReport } from './reclaimer'
import type { ReadWorktreeReportParams } from './reclaimer'
import { addRepository, listRepositories, removeRepository } from './registry'
import type { RegistryDeps } from './registry'
import { openTranscript, readSessionState, tailStore } from './sessions'
import type { OpenTranscriptParams, OpenTranscriptResult, ReadSessionStateParams, RepoRef, TailStore } from './sessions'
import { runSearch } from './search'
import type { RunSearchParams } from './search'
import { createPipelineWatcher } from './state'
import type { PipelineWatcher } from './state'

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

/** `'sessions:scan'`'s only composition: the ready repository list becomes
 *  `readSessionState`'s `repos`, never a second config or worktree reader —
 *  reconciliation against labels is #79's job, not this channel's. */
export interface SessionsScanDeps {
  readonly listRepositories: typeof listRepositories
  readonly readSessionState: (params: ReadSessionStateParams) => Promise<SessionScan>
}

const defaultSessionsScanDeps: SessionsScanDeps = { listRepositories, readSessionState }

function isReady(entry: RepositoryEntry): entry is Extract<RepositoryEntry, { status: 'ready' }> {
  return 'config' in entry
}

export async function resolveSessionsScan(registryDeps: RegistryDeps, deps: SessionsScanDeps = defaultSessionsScanDeps): Promise<SessionScan> {
  const list = await deps.listRepositories(registryDeps)
  if (!list.ok) throw new Error(`'sessions:scan' could not list repositories: ${list.message}`)
  const repos: readonly RepoRef[] = list.repositories.filter(isReady).map((entry) => ({ id: entry.id, root: entry.path }))
  return deps.readSessionState({ repos })
}

/** `'transcript:read'`'s only composition (#83, kept behind #84's byte-cursor
 *  primitive): a thin shim over `openTranscript` — open, read once through to
 *  EOF, then discard the cursor, since a one-shot caller never advances it.
 *  Same validation order and return shape #83's now-deleted `readTranscript`
 *  gave this channel; no second parallel line-reading code path lives beside
 *  the tail channels' `TailStore`.
 *
 *  Preserved but currently unused: no renderer code calls `'transcript:read'`
 *  any more — `main.ts`'s `handleOpenTranscript` goes exclusively through
 *  `transcriptTailOpen`. Kept per the rebase's own D1/D2 decision rather than
 *  removed, in case a one-shot caller returns. */
export interface TranscriptReadDeps {
  readonly openTranscript: (params: OpenTranscriptParams) => Promise<OpenTranscriptResult>
}

const defaultTranscriptReadDeps: TranscriptReadDeps = { openTranscript }

export async function resolveTranscriptRead(
  request: IpcMap['transcript:read']['request'],
  deps: TranscriptReadDeps = defaultTranscriptReadDeps,
): Promise<TranscriptRead> {
  if (typeof request?.sessionId !== 'string' || request.sessionId === '') {
    throw new Error("'transcript:read' requires a non-empty 'sessionId'")
  }
  if (request.agentId !== null && typeof request.agentId !== 'string') {
    throw new Error("'transcript:read' requires 'agentId' to be a string or null")
  }
  const { read } = await deps.openTranscript({ sessionId: request.sessionId, agentId: request.agentId })
  return read
}

/** The three tail channels' only composition: each request's own validation,
 *  then a direct call into the one running `TailStore` (`tailStore`) —
 *  injected here so a test exercises the validation branching without a real
 *  transcript on disk, the same seam every other channel's `*Deps` gives. */
export interface TranscriptTailDeps {
  readonly openTail: TailStore['openTail']
  readonly pollTail: TailStore['pollTail']
  readonly closeTail: TailStore['closeTail']
}

const defaultTranscriptTailDeps: TranscriptTailDeps = {
  openTail: (params) => tailStore.openTail(params),
  pollTail: (params) => tailStore.pollTail(params),
  closeTail: (params) => tailStore.closeTail(params),
}

export async function resolveTranscriptTailOpen(
  request: IpcMap['transcript:tail:open']['request'],
  deps: TranscriptTailDeps = defaultTranscriptTailDeps,
): Promise<TranscriptTailOpen> {
  if (typeof request?.sessionId !== 'string' || request.sessionId === '') {
    throw new Error("'transcript:tail:open' requires a non-empty 'sessionId'")
  }
  if (request.agentId !== null && typeof request.agentId !== 'string') {
    throw new Error("'transcript:tail:open' requires 'agentId' to be a string or null")
  }
  return deps.openTail({ sessionId: request.sessionId, agentId: request.agentId })
}

export async function resolveTranscriptTailPoll(
  request: IpcMap['transcript:tail:poll']['request'],
  deps: TranscriptTailDeps = defaultTranscriptTailDeps,
): Promise<TranscriptTailPoll> {
  if (typeof request?.tailId !== 'string' || request.tailId === '') {
    throw new Error("'transcript:tail:poll' requires a non-empty 'tailId'")
  }
  return deps.pollTail({ tailId: request.tailId })
}

export function resolveTranscriptTailClose(
  request: IpcMap['transcript:tail:close']['request'],
  deps: TranscriptTailDeps = defaultTranscriptTailDeps,
): void {
  if (typeof request?.tailId !== 'string' || request.tailId === '') {
    throw new Error("'transcript:tail:close' requires a non-empty 'tailId'")
  }
  deps.closeTail({ tailId: request.tailId })
}

/** `'search:query'`'s only composition: the same `resolveSessionsScan` every
 *  `'sessions:scan'` request builds becomes `runSearch`'s `scan` -- never a
 *  second scan builder -- so a repository this caller cannot read is the
 *  same `sessions-unavailable` answer either channel would give. */
export interface SearchQueryDeps {
  readonly resolveSessionsScan: (registryDeps: RegistryDeps) => Promise<SessionScan>
  readonly runSearch: (params: RunSearchParams) => Promise<SearchResult>
}

const defaultSearchQueryDeps: SearchQueryDeps = { resolveSessionsScan, runSearch }

function isValidScope(scope: unknown): scope is SearchScope {
  if (typeof scope !== 'object' || scope === null) return false
  const value = scope as Record<string, unknown>
  if (value['kind'] === 'all') return true
  return value['kind'] === 'repo' && typeof value['repoId'] === 'string' && value['repoId'] !== ''
}

/** A malformed payload throws (a renderer bug, per every other channel's own
 *  rule) -- a query that *parses* to zero usable terms is `runSearch`'s own
 *  `invalid-query` answer, a value rather than a thrown error, since it is
 *  still a well-formed request. */
export async function resolveSearchQuery(
  registryDeps: RegistryDeps,
  request: IpcMap['search:query']['request'],
  indexDir: string,
  deps: SearchQueryDeps = defaultSearchQueryDeps,
): Promise<SearchResult> {
  if (typeof request?.query !== 'string' || request.query === '') {
    throw new Error("'search:query' requires a non-empty 'query'")
  }
  if (!isValidScope(request.scope)) {
    throw new Error("'search:query' requires 'scope' to be { kind: 'repo', repoId } or { kind: 'all' }")
  }
  const scan = await deps.resolveSessionsScan(registryDeps)
  return deps.runSearch({ scan, indexDir, query: request.query, scope: request.scope })
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

export function registerIpc(): PipelineWatcher {
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

  // The board's own clock (#80) — one watcher for the process lifetime,
  // pushing every snapshot to every open window over `board:update`. The
  // registry is re-listed through the same `listRepositories` every other
  // channel reads, never a second config path.
  const watcher = createPipelineWatcher({
    repositories: async () => {
      const list = await listRepositories(registryDeps)
      return list.ok ? list.repositories : []
    },
    git: (args, cwd) => git(args, { cwd }),
    onSnapshot: (snapshot) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('board:update', snapshot)
      }
    },
  })

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

  for (const channel of IPC_CHANNELS) {
    if (!registered.has(channel)) {
      throw new Error(`IPC channel '${channel}' is declared but has no handler`)
    }
  }

  return watcher
}
