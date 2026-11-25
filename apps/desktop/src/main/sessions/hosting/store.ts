// The process-lifetime hosted-session store main/ipc.ts binds: the session lifecycle over the live handle registry and the persisted settings.
// A start past the current limit returns at-capacity, counted against live handles only.
import type { Platform } from '@/main/platform'
import type { HostedQueryFn } from '@/main/platform/sdk'
import type { SessionWorkspace } from '@/types/workspace'
import type { SessionReader } from '@/types/sessions'
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
  SessionInterruptResult,
  SessionInvokeResult,
  SessionKey,
  SessionPermissionAnswerResult,
  SessionRenameResult,
  SessionRestoreResult,
  SessionSendResult,
  SessionStartResult,
  SessionTaskStopResult,
  StartSessionParams,
  WorktreeChoice,
} from '@/types/hosting'
import { createHostedHandle } from '@/main/sessions/hosting/handle'
import { createHandleRegistry } from '@/main/sessions/hosting/handles'
import { createHostingSettings } from '@/main/sessions/hosting/settings'
import { readHistory } from '@/main/sessions/hosting/history'
import { titleFork } from '@/main/sessions/hosting/fork'
import { readStageEditAllow } from '@/main/sessions/hosting/stage-allow'
import { readStageDisabledPlugins } from '@/main/sessions/hosting/stage-plugins'
import { resolveStartTitle } from '@/main/sessions/hosting/title'
import { resolveClaudeExecutable } from '@/main/sessions/runtime/locate'
import { pathOps } from '@/main/platform/paths'
import { removeSessionWorktreeAt } from '@/main/repos/worktree/worktree'

export interface HostedStoreOptions {
  /** The engine-routed session list, used for fork titling and a resumed session's start title. */
  readonly listSessions: SessionReader
  readonly persistence: HostingPersistence
  readonly onEvent?: (envelope: SessionEventEnvelope) => void
  readonly onStatus?: (snapshot: HostedSessionSnapshot) => void
  /** Forwarded verbatim to every handle's own `onEntries`. */
  readonly onEntries?: (delta: SessionEntriesDelta) => void
}

function toSessionKey(n: number): SessionKey {
  return `hosted-${String(n)}` as SessionKey
}

export function createHostedStore(ctx: Pick<Platform, 'sdk' | 'which' | 'git' | 'fs' | 'clock' | 'claudeHome'>, options: HostedStoreOptions): HostedStore {
  const handles = createHandleRegistry()
  const settings = createHostingSettings(options.persistence, handles.list)
  const now = (): number => ctx.clock.now().getTime()
  const onEvent = options.onEvent ?? (() => undefined)
  const onStatus = options.onStatus ?? (() => undefined)
  const onEntries = options.onEntries ?? (() => undefined)
  let nextId = 1

  function onHandleStatus(snapshot: HostedSessionSnapshot): void {
    onStatus(snapshot)
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
      const busy = handles.findFolderBusy(params.workspace.folder, (a, b) => pathOps.samePath(a, b))
      if (busy !== null) return { ok: false, kind: 'folder-busy', sessionKey: busy.sessionKey }
    }

    const limit = settings.limit()
    if (handles.liveCount() >= limit) {
      return { ok: false, kind: 'at-capacity', limit }
    }

    const located = await resolveClaudeExecutable(ctx)
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
    const editAllowRead: Promise<readonly string[]> = stageParams === null ? Promise.resolve([]) : readStageEditAllow(ctx, cwd)
    const disabledPluginsRead: Promise<readonly string[]> = stageParams === null ? Promise.resolve([]) : readStageDisabledPlugins(ctx, cwd)
    const [sdk, history, editAllow, disabledPlugins] = await Promise.all([ctx.sdk.load(), readHistory(ctx, params.mode), editAllowRead, disabledPluginsRead])
    const sessionKey = toSessionKey(nextId)
    nextId += 1
    const mode = params.mode
    const queryFn: HostedQueryFn = (queryParams) => sdk.query(queryParams)
    const initialTitle = params.initialTitle ?? null
    const stage = stageParams === null ? null : { ...stageParams, editAllow, disabledPlugins }

    function onSessionId(claudeSessionId: string): void {
      settings.dropAdopted(claudeSessionId)
      if (mode.kind === 'fork') {
        void titleFork(sdk, options.listSessions, { parentSessionId: mode.sessionId, forkedSessionId: claudeSessionId, cwd }).then((titled) => handles.get(sessionKey)?.setTitled(titled))
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
        now,
        onEvent,
        onStatus: onHandleStatus,
        onSessionId,
        onEntries,
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
      void resolveStartTitle(mode, options.listSessions).then((title) => {
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
    options.persistence.freeze()
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
      const outcome = await removeSessionWorktreeAt(ctx, { path: sessionWorktree.path, force: worktree === 'force' })
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
      const sdk = await ctx.sdk.load()
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
