import type { HostedHandle, MintedRestorable, SessionMarksTracker } from '@/types/hosting'
import type { HostedQueryFn, HostedSdk } from '@/main/hosting/sdk'
import type { WhichEnv, WhichOptions, WhichResult, FileResult, DirEntry } from '@/types/platform'
import type { CredentialsTell } from '@/types/runtime'
import type { HostingPersistence, SessionHistory } from '@/types/hosting'
import type { ExpectedComponents, PluginRequest } from '@/types/hosting-plugin'
import type { RemoveSessionWorktreeOutcome } from '@/types/workspace'
import type { OpenTranscriptParams, TranscriptCursor } from '@/types/sessions'
import type { TranscriptRead } from '@/utils/sessions/transcript'

// Map<sessionKey, Handle>, the process-lifetime instance main/ipc.ts binds, plus closeAll().
// A start past the current limit returns at-capacity, counted against live handles only.
import type { RepoId } from '@/utils/repos'
import type { PlanAnswerResult, PlanDecision, QuestionAnswerResult, SessionControls, SetControlsResult } from '@/utils/hosting/controls'
import type { ComposerAttachment } from '@/utils/hosting/attachments'
import { DEFAULT_SESSION_DEFAULTS } from '@/types/hosting'
import type { HostedStore, StartSessionParams } from '@/types/hosting'
import type {
  HostedSessionSnapshot,
  HostingCapacity,
  PermissionDecision,
  SessionAttachResult,
  SessionCloseResult,
  SessionDefaults,
  SessionDismissResult,
  SessionEntriesDelta,
  SessionEventEnvelope,
  SessionInterruptResult,
  SessionInvokeResult,
  SessionKey,
  SessionMarkResult,
  SessionMarks,
  SessionPermissionAnswerResult,
  SessionRenameResult,
  SessionRestoreDiscardResult,
  SessionRestoreResult,
  SessionSendResult,
  SessionStartMode,
  SessionStartResult,
  SessionTaskStopResult,
  WorktreeChoice,
} from '@/types/hosting'
import { createHostedHandle } from '@/main/hosting/handle'
import { createSessionMarks } from '@/main/hosting/marks'


import { createHostedSdk } from '@/main/hosting/sdk'

import { readHistory } from '@/main/hosting/history'
import { defaultForkListSessions, titleFork } from '@/main/hosting/fork'
import { defaultReadExpectedComponentsDeps, readExpectedComponents, resolvePluginRequest } from '@/main/hosting/plugin'
import { readStageEditAllow } from '@/main/hosting/stage-allow'
import { resolveStartTitle } from '@/main/hosting/title'
import { createInMemoryHostingPersistence, DEFAULT_SESSION_LIMIT, SESSION_LIMIT_CEILING } from '@/main/hosting/persist'

import { dropAdopted, mintRestorable, nextPersisted, persistedOpen } from '@/main/hosting/restore'

import { findAlreadyOpen, findFolderBusy } from '@/main/hosting/occupancy'
import type { SessionReader } from '@/types/sessions'
import { readCredentialsTell } from '@/main/runtime/credentials'
import { resolveClaudeExecutable } from '@/main/runtime/locate'
import { pathOps } from '@/main/platform/paths'
import { defaultGitRunner } from '@/main/platform/git'
import { removeSessionWorktreeAt } from '@/main/workspace/worktree'

import type { SessionWorkspace } from '@/types/workspace'

export { DEFAULT_SESSION_LIMIT, SESSION_LIMIT_CEILING } from '@/main/hosting/persist'

/** Ended handles retained up to this many; the oldest-ended is evicted on the next `end`. */
export const ENDED_RETAIN_LIMIT = 20

export interface HostedStoreDeps {
  readonly getSdk: () => Promise<HostedSdk>
  readonly resolveClaudeExecutable: (options: { readonly env: WhichEnv; readonly platform: NodeJS.Platform; readonly which?: (options: WhichOptions) => Promise<WhichResult> }) => Promise<
    { readonly ok: true; readonly path: string } | { readonly ok: false; readonly kind: 'not-found'; readonly searched: readonly string[] } | { readonly ok: false; readonly kind: 'bundled-fallback'; readonly path: string }
  >
  readonly readCredentialsTell: (options?: { readonly claudeHome?: string }) => Promise<CredentialsTell>
  readonly listSessionsForFork: SessionReader
  readonly env: NodeJS.ProcessEnv
  readonly platform: NodeJS.Platform
  readonly now: () => number
  readonly onEvent: (envelope: SessionEventEnvelope) => void
  readonly onStatus: (snapshot: HostedSessionSnapshot) => void
  /** Forwarded verbatim to every handle's own `onEntries`. */
  readonly onEntries: (delta: SessionEntriesDelta) => void
  /** Resolved once per operator `start()`, after the executable and before a key is minted; a stage start always requests the installed plugin and never calls it. */
  readonly resolvePluginRequest: (repoRoot: string, deps?: { readonly readJsonFile: <T>(path: string) => Promise<FileResult<T>> }) => Promise<PluginRequest>
  readonly readExpectedComponents: (pluginPath: string, deps?: { readonly listDirectory: (path: string) => Promise<FileResult<readonly DirEntry[]>> }) => Promise<ExpectedComponents | null>
  /** A stage start's own edit-allow globs, read from the stage worktree. */
  readonly readStageEditAllow: (cwd: string) => Promise<readonly string[]>
  readonly samePath: (a: string, b: string) => boolean
  /** `main/ipc.ts` supplies the real file-backed one; the default here is disk-free, for tests. */
  readonly persistence: HostingPersistence
  /** Removes a worktree on an explicit `dismiss` choice — the default wraps `removeSessionWorktreeAt` with a real `GitRunner`. */
  readonly removeWorktree: (path: string, force: boolean) => Promise<RemoveSessionWorktreeOutcome>
  readonly readHistory: (mode: SessionStartMode, deps?: { readonly openTranscript: (params: OpenTranscriptParams) => Promise<{ readonly read: TranscriptRead; readonly cursor: TranscriptCursor | null }> }) => Promise<SessionHistory>
}

export const defaultHostedStoreDeps: HostedStoreDeps = {
  getSdk: createHostedSdk(),
  resolveClaudeExecutable,
  readCredentialsTell,
  listSessionsForFork: defaultForkListSessions,
  env: process.env,
  platform: process.platform,
  now: () => Date.now(),
  onEvent: () => undefined,
  onStatus: () => undefined,
  onEntries: () => undefined,
  resolvePluginRequest,
  readExpectedComponents: (pluginPath: string) => readExpectedComponents(pluginPath, defaultReadExpectedComponentsDeps),
  readStageEditAllow: (cwd: string) => readStageEditAllow(cwd),
  samePath: (a: string, b: string) => pathOps.samePath(a, b),
  persistence: createInMemoryHostingPersistence(),
  removeWorktree: (path, force) => removeSessionWorktreeAt({ path, force, git: defaultGitRunner() }),
  readHistory,
}

function toSessionKey(n: number): SessionKey {
  return `hosted-${String(n)}` as SessionKey
}

export function createHostedStore(deps: HostedStoreDeps = defaultHostedStoreDeps): HostedStore {
  const handles = new Map<SessionKey, HostedHandle>()
  let nextId = 1
  let limit = DEFAULT_SESSION_LIMIT
  let defaults: SessionDefaults = DEFAULT_SESSION_DEFAULTS
  let restorable: readonly MintedRestorable[] = []
  const endedOrder: SessionKey[] = []
  const endedSeen = new Set<SessionKey>()
  let loaded: Promise<void> | null = null
  let marksTracker: SessionMarksTracker = createSessionMarks({ pinned: [], archived: [] })

  function ensureLoaded(): Promise<void> {
    if (loaded === null) {
      loaded = deps.persistence.load().then((state) => {
        limit = state.limit
        restorable = mintRestorable(state.open)
        defaults = state.defaults
        marksTracker = createSessionMarks(state.marks)
      })
    }
    return loaded
  }

  function liveCount(): number {
    let count = 0
    for (const handle of handles.values()) {
      if (handle.snapshot().phase !== 'ended') count += 1
    }
    return count
  }

  function list(): readonly HostedSessionSnapshot[] {
    return [...handles.values()].map((handle) => handle.snapshot())
  }

  function persistSave(): void {
    const live = persistedOpen(list())
    deps.persistence.save({ ...nextPersisted({ limit, live, restorable }), defaults, marks: marksTracker.current() })
  }

  function forgetHandle(sessionKey: SessionKey): void {
    handles.delete(sessionKey)
    endedSeen.delete(sessionKey)
    const index = endedOrder.indexOf(sessionKey)
    if (index !== -1) endedOrder.splice(index, 1)
  }

  function onHandleStatus(snapshot: HostedSessionSnapshot): void {
    deps.onStatus(snapshot)
    if (snapshot.phase === 'ended' && !endedSeen.has(snapshot.sessionKey)) {
      endedSeen.add(snapshot.sessionKey)
      endedOrder.push(snapshot.sessionKey)
      while (endedOrder.length > ENDED_RETAIN_LIMIT) {
        const evicted = endedOrder.shift()
        if (evicted !== undefined) forgetHandle(evicted)
      }
    }
    persistSave()
  }

  async function start(params: StartSessionParams): Promise<SessionStartResult> {
    await ensureLoaded()

    if (params.mode.kind === 'resume' || params.mode.kind === 'resume-at') {
      const existing = findAlreadyOpen(handles, params.mode.sessionId)
      if (existing !== null) return { ok: false, kind: 'already-open', sessionKey: existing.sessionKey }
    }

    if (params.workspace.worktree === null) {
      const busy = findFolderBusy(handles, params.workspace.folder, deps.samePath)
      if (busy !== null) return { ok: false, kind: 'folder-busy', sessionKey: busy.sessionKey }
    }

    if (liveCount() >= limit) {
      return { ok: false, kind: 'at-capacity', limit }
    }

    const located = await deps.resolveClaudeExecutable({ env: deps.env, platform: deps.platform })
    if (!located.ok) {
      return {
        ok: false,
        kind: 'runtime',
        diagnosis: located.kind === 'not-found' ? 'cli-missing' : 'bundled-fallback',
        detail: located.kind === 'bundled-fallback' ? located.path : null,
      }
    }

    const cwd = params.workspace.folder
    const stageParams = params.stage ?? null
    const pluginRequest: Promise<PluginRequest> = stageParams === null ? deps.resolvePluginRequest(cwd) : Promise.resolve({ source: 'installed' })
    const editAllowRead: Promise<readonly string[]> = stageParams === null ? Promise.resolve([]) : deps.readStageEditAllow(cwd)
    const [credentials, sdk, plugin, history, editAllow] = await Promise.all([deps.readCredentialsTell(), deps.getSdk(), pluginRequest, deps.readHistory(params.mode), editAllowRead])
    const sessionKey = toSessionKey(nextId)
    nextId += 1
    const mode = params.mode
    const queryFn: HostedQueryFn = (queryParams) => sdk.query(queryParams)
    const initialTitle = params.initialTitle ?? null
    const stage = stageParams === null ? null : { ...stageParams, editAllow }

    function onSessionId(claudeSessionId: string): void {
      restorable = dropAdopted(restorable, claudeSessionId)
      if (mode.kind === 'fork') {
        void titleFork(
          { parentSessionId: mode.sessionId, forkedSessionId: claudeSessionId, cwd },
          { listSessions: deps.listSessionsForFork, renameSession: sdk.renameSession },
        ).then((titled) => handles.get(sessionKey)?.setTitled(titled))
      }
      if (stage !== null && initialTitle !== null) {
        void sdk.renameSession(claudeSessionId, initialTitle, { dir: cwd }).then(
          () => handles.get(sessionKey)?.setTitled(true),
          () => handles.get(sessionKey)?.setTitled(false),
        )
      }
      persistSave()
    }

    const handle = createHostedHandle(
      {
        sessionKey,
        repoId: params.repoId,
        workspace: params.workspace,
        mode,
        cwd,
        executablePath: located.path,
        credentials,
        now: deps.now,
        onEvent: deps.onEvent,
        onStatus: onHandleStatus,
        onSessionId,
        onEntries: deps.onEntries,
        plugin,
        readExpectedComponents: deps.readExpectedComponents,
        samePath: deps.samePath,
        initialTitle,
        defaults,
        history,
        stage,
      },
      queryFn,
    )
    handles.set(sessionKey, handle)
    persistSave()

    if (initialTitle === null && mode.kind !== 'fresh') {
      void resolveStartTitle(mode, deps.listSessionsForFork).then((title) => {
        if (title !== null) handles.get(sessionKey)?.setTitle(title)
      })
    }

    return { ok: true, snapshot: handle.snapshot() }
  }

  function send(sessionKey: SessionKey, text: string, attachments: readonly ComposerAttachment[] = [], options: { readonly source: 'operator' | 'app' } = { source: 'app' }): SessionSendResult {
    const handle = handles.get(sessionKey)
    if (!handle) return { ok: false, kind: 'unknown-session' }
    const result = handle.send(text, attachments, options.source)
    if (!result.ok) return result
    return { ok: true, uuid: result.uuid, queued: result.queued }
  }

  async function interrupt(sessionKey: SessionKey): Promise<SessionInterruptResult> {
    const handle = handles.get(sessionKey)
    if (!handle) return { ok: false, kind: 'unknown-session' }
    const queuedAfterInterrupt = await handle.interrupt()
    return { ok: true, queuedAfterInterrupt }
  }

  async function close(sessionKey: SessionKey): Promise<SessionCloseResult> {
    const handle = handles.get(sessionKey)
    if (!handle) return { ok: false, kind: 'unknown-session' }
    await handle.close()
    return { ok: true }
  }

  function attach(sessionKey: SessionKey): SessionAttachResult {
    const handle = handles.get(sessionKey)
    if (!handle) return { ok: false, kind: 'unknown-session' }
    const { events, droppedBefore } = handle.replay()
    const { entries, firstIndex, partial, pendingSends, revision } = handle.entriesWindow()
    return { ok: true, snapshot: handle.snapshot(), replay: events, droppedBefore, entries, firstIndex, partial, pendingSends, revision, history: handle.history() }
  }

  function stopTask(sessionKey: SessionKey, taskId: string): Promise<SessionTaskStopResult> {
    const handle = handles.get(sessionKey)
    if (!handle) return Promise.resolve({ ok: false, kind: 'unknown-session' })
    return handle.stopTask(taskId)
  }

  async function closeAll(): Promise<void> {
    // Freezing first keeps the 'closing' phase quitting causes from erasing the persisted set.
    deps.persistence.freeze()
    await Promise.all([...handles.values()].map((handle) => handle.close()))
  }

  function answerPermission(sessionKey: SessionKey, permissionId: string, decision: PermissionDecision, message: string | null): SessionPermissionAnswerResult {
    const handle = handles.get(sessionKey)
    if (!handle) return { ok: false, kind: 'unknown-session' }
    return handle.answerPermission(permissionId, decision, message)
  }

  function invoke(sessionKey: SessionKey, name: string, args: string): SessionInvokeResult {
    const handle = handles.get(sessionKey)
    if (!handle) return { ok: false, kind: 'unknown-session' }
    return handle.invoke(name, args)
  }

  async function setControls(sessionKey: SessionKey, patch: { readonly permissionMode?: SessionControls['permissionMode']; readonly model?: string; readonly effort?: SessionControls['effort'] }): Promise<SetControlsResult> {
    const handle = handles.get(sessionKey)
    if (!handle) return { ok: false, kind: 'unknown-session' }
    return handle.setControls(patch)
  }

  function answerQuestion(sessionKey: SessionKey, permissionId: string, answers: Readonly<Record<string, string>>): QuestionAnswerResult {
    const handle = handles.get(sessionKey)
    if (!handle) return { ok: false, kind: 'unknown-session' }
    return handle.answerQuestion(permissionId, answers)
  }

  function answerPlan(sessionKey: SessionKey, permissionId: string, decision: PlanDecision): PlanAnswerResult {
    const handle = handles.get(sessionKey)
    if (!handle) return { ok: false, kind: 'unknown-session' }
    return handle.answerPlan(permissionId, decision)
  }

  async function dismiss(sessionKey: SessionKey, worktree: WorktreeChoice): Promise<SessionDismissResult> {
    const handle = handles.get(sessionKey)
    if (!handle) return { ok: false, kind: 'unknown-session' }
    if (handle.snapshot().phase !== 'ended') return { ok: false, kind: 'still-open' }

    const sessionWorktree = handle.snapshot().workspace.worktree
    if (sessionWorktree !== null && worktree !== 'keep') {
      const outcome = await deps.removeWorktree(sessionWorktree.path, worktree === 'force')
      if (outcome.outcome === 'dirty') return { ok: false, kind: 'worktree-dirty' }
      if (outcome.outcome === 'failed') return { ok: false, kind: 'worktree-remove-failed', message: outcome.message }
    }

    forgetHandle(sessionKey)
    persistSave()
    return { ok: true }
  }

  function snapshotOf(sessionKey: SessionKey): HostedSessionSnapshot | null {
    return handles.get(sessionKey)?.snapshot() ?? null
  }

  function cwdOf(sessionKey: SessionKey): string | null {
    return handles.get(sessionKey)?.cwd ?? null
  }

  async function capacity(): Promise<HostingCapacity> {
    await ensureLoaded()
    return { limit, ceiling: SESSION_LIMIT_CEILING }
  }

  async function setLimit(next: number): Promise<HostingCapacity> {
    await ensureLoaded()
    limit = next
    persistSave()
    return { limit, ceiling: SESSION_LIMIT_CEILING }
  }

  async function getDefaults(): Promise<SessionDefaults> {
    await ensureLoaded()
    return defaults
  }

  async function setDefaults(next: SessionDefaults): Promise<SessionDefaults> {
    await ensureLoaded()
    defaults = next
    persistSave()
    return defaults
  }

  async function rename(sessionKey: SessionKey, title: string): Promise<SessionRenameResult> {
    const handle = handles.get(sessionKey)
    if (!handle) return { ok: false, kind: 'unknown-session' }
    const claudeSessionId = handle.snapshot().claudeSessionId
    if (claudeSessionId === null) return { ok: false, kind: 'not-ready' }
    try {
      const sdk = await deps.getSdk()
      await sdk.renameSession(claudeSessionId, title, { dir: handle.cwd })
      handle.rename(title)
      return { ok: true }
    } catch (error) {
      return { ok: false, kind: 'rename-failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  async function restorableList(): Promise<readonly MintedRestorable[]> {
    await ensureLoaded()
    return restorable
  }

  async function restore(restoreId: string, resolved: { readonly repoId: RepoId | null; readonly workspace: SessionWorkspace }): Promise<SessionRestoreResult> {
    await ensureLoaded()
    const entry = restorable.find((candidate) => candidate.restoreId === restoreId)
    if (entry === undefined) return { ok: false, kind: 'unknown-restore' }
    const result = await start({ repoId: resolved.repoId, mode: { kind: 'resume', sessionId: entry.claudeSessionId }, workspace: resolved.workspace, initialTitle: entry.title })
    if (result.ok || result.kind === 'already-open') {
      restorable = restorable.filter((candidate) => candidate.restoreId !== restoreId)
      persistSave()
    }
    return result
  }

  async function discardRestorable(restoreId: string | null): Promise<SessionRestoreDiscardResult> {
    await ensureLoaded()
    restorable = restoreId === null ? [] : restorable.filter((candidate) => candidate.restoreId !== restoreId)
    persistSave()
    return { ok: true }
  }

  async function marks(): Promise<SessionMarks> {
    await ensureLoaded()
    return marksTracker.current()
  }

  async function setMark(kind: 'pinned' | 'archived', sessionId: string, on: boolean): Promise<SessionMarkResult> {
    await ensureLoaded()
    if (sessionId === '' || sessionId.length > 200) return { ok: false, kind: 'invalid-session-id' }
    const result = marksTracker.set(kind, sessionId, on)
    persistSave()
    return { ok: true, marks: result }
  }

  return {
    start,
    send,
    interrupt,
    close,
    attach,
    list,
    closeAll,
    answerPermission,
    invoke,
    setControls,
    answerQuestion,
    answerPlan,
    dismiss,
    snapshotOf,
    cwdOf,
    capacity,
    setLimit,
    defaults: getDefaults,
    setDefaults,
    rename,
    restorable: restorableList,
    restore,
    discardRestorable,
    marks,
    setMark,
    stopTask,
  }
}
