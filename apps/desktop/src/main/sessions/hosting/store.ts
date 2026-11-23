// The process-lifetime hosted-session store main/ipc.ts binds: the session lifecycle over the live handle registry and the persisted settings.
// A start past the current limit returns at-capacity, counted against live handles only.
import { defaultSdk, type HostedQueryFn, type HostedSdk } from '@/main/platform/sdk'
import type { WhichEnv, WhichOptions, WhichResult } from '@/types/platform'
import type { RemoveSessionWorktreeOutcome, SessionWorkspace } from '@/types/workspace'
import type { OpenTranscriptParams, SessionReader, TranscriptCursor } from '@/types/sessions'
import type { TranscriptRead } from '@/utils/sessions/transcript'
import type { RepoId } from '@/utils/repos'
import type { PlanAnswerResult, PlanDecision, QuestionAnswerResult, SessionControls, SetControlsResult } from '@/utils/hosting/controls'
import type { ComposerAttachment } from '@/utils/hosting/attachments'
import type {
  HostedStore,
  HostingPersistence,
  HostedSessionSnapshot,
  MintedRestorable,
  PermissionDecision,
  SessionAttachResult,
  SessionCloseResult,
  SessionDismissResult,
  SessionEntriesDelta,
  SessionEventEnvelope,
  SessionHistory,
  SessionInterruptResult,
  SessionInvokeResult,
  SessionKey,
  SessionPermissionAnswerResult,
  SessionRenameResult,
  SessionRestoreResult,
  SessionSendResult,
  SessionStartMode,
  SessionStartResult,
  SessionTaskStopResult,
  StartSessionParams,
  WorktreeChoice,
} from '@/types/hosting'
import { createHostedHandle } from '@/main/sessions/hosting/handle'
import { createHandleRegistry } from '@/main/sessions/hosting/handles'
import { createHostingSettings } from '@/main/sessions/hosting/settings'
import { readHistory } from '@/main/sessions/hosting/history'
import { defaultForkListSessions, titleFork } from '@/main/sessions/hosting/fork'
import { readStageEditAllow } from '@/main/sessions/hosting/stage-allow'
import { resolveStartTitle } from '@/main/sessions/hosting/title'
import { createInMemoryHostingPersistence } from '@/main/sessions/hosting/persist'
import { resolveClaudeExecutable } from '@/main/sessions/runtime/locate'
import { pathOps } from '@/main/platform/paths'
import { defaultGitRunner } from '@/main/platform/git'
import { removeSessionWorktreeAt } from '@/main/repos/worktree/worktree'

export interface HostedStoreDeps {
  readonly getSdk: () => Promise<HostedSdk>
  readonly resolveClaudeExecutable: (options: { readonly env: WhichEnv; readonly platform: NodeJS.Platform; readonly which?: (options: WhichOptions) => Promise<WhichResult> }) => Promise<
    { readonly ok: true; readonly path: string } | { readonly ok: false; readonly kind: 'not-found'; readonly searched: readonly string[] } | { readonly ok: false; readonly kind: 'bundled-fallback'; readonly path: string }
  >
  readonly listSessionsForFork: SessionReader
  readonly env: NodeJS.ProcessEnv
  readonly platform: NodeJS.Platform
  readonly now: () => number
  readonly onEvent: (envelope: SessionEventEnvelope) => void
  readonly onStatus: (snapshot: HostedSessionSnapshot) => void
  /** Forwarded verbatim to every handle's own `onEntries`. */
  readonly onEntries: (delta: SessionEntriesDelta) => void
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
  getSdk: defaultSdk.load,
  resolveClaudeExecutable,
  listSessionsForFork: defaultForkListSessions,
  env: process.env,
  platform: process.platform,
  now: () => Date.now(),
  onEvent: () => undefined,
  onStatus: () => undefined,
  onEntries: () => undefined,
  readStageEditAllow: (cwd: string) => readStageEditAllow(cwd),
  samePath: (a: string, b: string) => pathOps.samePath(a, b),
  persistence: createInMemoryHostingPersistence(),
  removeWorktree: (path, force) => removeSessionWorktreeAt({ git: defaultGitRunner() }, { path, force }),
  readHistory,
}

function toSessionKey(n: number): SessionKey {
  return `hosted-${String(n)}` as SessionKey
}

export function createHostedStore(deps: HostedStoreDeps = defaultHostedStoreDeps): HostedStore {
  const handles = createHandleRegistry()
  const settings = createHostingSettings(deps.persistence, handles.list)
  let nextId = 1

  function onHandleStatus(snapshot: HostedSessionSnapshot): void {
    deps.onStatus(snapshot)
    handles.noteStatus(snapshot)
    settings.save()
  }

  async function start(params: StartSessionParams): Promise<SessionStartResult> {
    await settings.ensureLoaded()

    if (params.mode.kind === 'resume' || params.mode.kind === 'resume-at') {
      const existing = handles.findAlreadyOpen(params.mode.sessionId)
      if (existing !== null) return { ok: false, kind: 'already-open', sessionKey: existing.sessionKey }
    }

    if (params.workspace.worktree === null) {
      const busy = handles.findFolderBusy(params.workspace.folder, deps.samePath)
      if (busy !== null) return { ok: false, kind: 'folder-busy', sessionKey: busy.sessionKey }
    }

    const limit = settings.limit()
    if (handles.liveCount() >= limit) {
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
    const editAllowRead: Promise<readonly string[]> = stageParams === null ? Promise.resolve([]) : deps.readStageEditAllow(cwd)
    const [sdk, history, editAllow] = await Promise.all([deps.getSdk(), deps.readHistory(params.mode), editAllowRead])
    const sessionKey = toSessionKey(nextId)
    nextId += 1
    const mode = params.mode
    const queryFn: HostedQueryFn = (queryParams) => sdk.query(queryParams)
    const initialTitle = params.initialTitle ?? null
    const stage = stageParams === null ? null : { ...stageParams, editAllow }

    function onSessionId(claudeSessionId: string): void {
      settings.dropAdopted(claudeSessionId)
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
      settings.save()
    }

    const handle = createHostedHandle(
      {
        sessionKey,
        repoId: params.repoId,
        workspace: params.workspace,
        mode,
        cwd,
        executablePath: located.path,
        now: deps.now,
        onEvent: deps.onEvent,
        onStatus: onHandleStatus,
        onSessionId,
        onEntries: deps.onEntries,
        initialTitle,
        defaults: settings.sessionDefaults(),
        history,
        stage,
      },
      queryFn,
    )
    handles.set(sessionKey, handle)
    settings.save()

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
    await Promise.all(handles.all().map((handle) => handle.close()))
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

    handles.forget(sessionKey)
    settings.save()
    return { ok: true }
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

  async function restore(restoreId: string, resolved: { readonly repoId: RepoId | null; readonly workspace: SessionWorkspace }): Promise<SessionRestoreResult> {
    await settings.ensureLoaded()
    const entry: MintedRestorable | undefined = settings.findRestorable(restoreId)
    if (entry === undefined) return { ok: false, kind: 'unknown-restore' }
    const result = await start({ repoId: resolved.repoId, mode: { kind: 'resume', sessionId: entry.claudeSessionId }, workspace: resolved.workspace, initialTitle: entry.title })
    if (result.ok || result.kind === 'already-open') settings.removeRestorable(restoreId)
    return result
  }

  return {
    start,
    send,
    interrupt,
    close,
    attach,
    list: handles.list,
    closeAll,
    answerPermission,
    invoke,
    setControls,
    answerQuestion,
    answerPlan,
    dismiss,
    snapshotOf: (sessionKey) => handles.get(sessionKey)?.snapshot() ?? null,
    cwdOf: (sessionKey) => handles.get(sessionKey)?.cwd ?? null,
    capacity: settings.capacity,
    setLimit: settings.setLimit,
    defaults: settings.defaults,
    setDefaults: settings.setDefaults,
    notificationPrefs: settings.notificationPrefs,
    setNotificationPrefs: settings.setNotificationPrefs,
    rename,
    restorable: settings.restorableList,
    restore,
    discardRestorable: settings.discardRestorable,
    marks: settings.marks,
    setMark: settings.setMark,
    stopTask,
  }
}
