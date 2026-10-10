// Session start/send/stop/close/dismiss, plus the cross-screen entry points the sidebar, palette and keyboard map call directly.
import { toast } from 'sonner'
import type { QueryClient } from '@tanstack/react-query'
import { router } from '../router/router'
import { ROUTE_IDS } from '../router/routes'
import { ipcQueryOptions } from '../data/query'
import { invoke } from '../data/invoke'
import type { RepoId } from '../../../shared/repos'
import type { HostedSessionSnapshot, SessionDismissResult, SessionKey, SessionStartResult, SessionTaskStopResult, WorktreeChoice } from '../../../shared/hosting/types'
import type { PlanAnswerResult, PlanDecision, QuestionAnswerResult, SessionControls, SessionEffort, SetControlsResult } from '../../../shared/hosting/controls'
import type { ComposerAttachment } from '../../../shared/hosting/attachments'
import type { FolderId } from '../../../shared/workspace/types'
import { folderMissingToast, startFailureCopy, START_UNREACHABLE } from './copy'
import type { RenderableStartFailure, StartFailureCopy } from './copy'
import { clearDraft, clearDraftAttachments } from './drafts'
import { forgetSessionEntries } from './entries-store'

let queryClient: QueryClient | null = null

/** Called once from `main.ts`'s boot, the same seam `currentRepositories` there already uses. */
export function setSessionsQueryClient(client: QueryClient): void {
  queryClient = client
}

function sessionListKey() {
  return ipcQueryOptions('session:list').queryKey
}

/** Adopts a snapshot into the `session:list` cache — the restore banner's own resumes use this too. */
export function adoptSession(snapshot: HostedSessionSnapshot): void {
  if (queryClient === null) return
  const key = sessionListKey()
  const existing = queryClient.getQueryData<readonly HostedSessionSnapshot[]>(key)
  if (existing === undefined) {
    void queryClient.invalidateQueries({ queryKey: key })
    return
  }
  const found = existing.some((entry) => entry.sessionKey === snapshot.sessionKey)
  queryClient.setQueryData(key, found ? existing.map((entry) => (entry.sessionKey === snapshot.sessionKey ? snapshot : entry)) : [...existing, snapshot])
}

function removeSession(key: SessionKey): void {
  if (queryClient === null) return
  const listKey = sessionListKey()
  const existing = queryClient.getQueryData<readonly HostedSessionSnapshot[]>(listKey)
  if (existing === undefined) return
  queryClient.setQueryData(
    listKey,
    existing.filter((entry) => entry.sessionKey !== key),
  )
}

export function liveSessionKeys(): readonly SessionKey[] {
  const data = queryClient?.getQueryData<readonly HostedSessionSnapshot[]>(sessionListKey()) ?? []
  return data.filter((snapshot) => snapshot.phase !== 'ended').map((snapshot) => snapshot.sessionKey)
}

function handleStartResult(result: SessionStartResult): void {
  if (result.ok) {
    adoptSession(result.snapshot)
    void router.navigate({ to: ROUTE_IDS.session, search: { key: result.snapshot.sessionKey } })
    return
  }
  if (result.kind === 'already-open') void router.navigate({ to: ROUTE_IDS.session, search: { key: result.sessionKey } })
}

export type StartInFolderOutcome = { readonly kind: 'started' } | { readonly kind: 'failed'; readonly copy: StartFailureCopy; readonly result: RenderableStartFailure | null }

/** The New session dialog's own start — stays open on failure so the dialog can show the inline banner. */
export async function startInFolder(folderId: FolderId, worktree: boolean): Promise<StartInFolderOutcome> {
  try {
    const result = await invoke('session:start', { target: { kind: 'folder', folderId, worktree }, mode: { kind: 'fresh' } })
    if (result.ok || result.kind === 'already-open') {
      handleStartResult(result)
      return { kind: 'started' }
    }
    return { kind: 'failed', copy: startFailureCopy(result), result }
  } catch (error) {
    console.error('Failed to reach the main process starting a session', error)
    return { kind: 'failed', copy: { title: 'Could not start a session', body: START_UNREACHABLE, detail: null }, result: null }
  }
}

/** The sidebar's own session row click, and the keyboard map's jump/next. */
export function selectSession(key: SessionKey): void {
  void router.navigate({ to: ROUTE_IDS.session, search: { key } })
}

export interface SendOutcome {
  readonly ok: boolean
  readonly error: string | null
  /** The blocked command's own name, set only when `error` is `'blocked-command'`. */
  readonly blockedCommandName: string | null
}

export async function send(key: SessionKey, text: string, attachments: readonly ComposerAttachment[] = []): Promise<SendOutcome> {
  try {
    const result = await invoke('session:send', { sessionKey: key, text, attachments })
    if (result.ok) return { ok: true, error: null, blockedCommandName: null }
    if (result.kind === 'blocked-command') return { ok: false, error: 'blocked-command', blockedCommandName: result.name }
    return { ok: false, error: 'unknown-session', blockedCommandName: null }
  } catch (error) {
    console.error('Failed to reach the main process sending a message', error)
    return { ok: false, error: 'unreachable', blockedCommandName: null }
  }
}

export async function stop(key: SessionKey): Promise<number | null | 'unreachable'> {
  try {
    const result = await invoke('session:interrupt', { sessionKey: key })
    return result.ok ? result.queuedAfterInterrupt : null
  } catch (error) {
    console.error('Failed to reach the main process interrupting a session', error)
    return 'unreachable'
  }
}

export async function close(key: SessionKey): Promise<void> {
  try {
    await invoke('session:close', { sessionKey: key })
  } catch (error) {
    console.error('Failed to reach the main process closing a session', error)
  }
}

// Dismisses with the given worktree choice; clears local state only on `ok`.
export async function dismiss(key: SessionKey, choice: WorktreeChoice): Promise<SessionDismissResult | 'unreachable'> {
  try {
    const result = await invoke('session:dismiss', { sessionKey: key, worktree: choice })
    if (result.ok) {
      removeSession(key)
      forgetSessionEntries(key)
      clearDraft(key)
      clearDraftAttachments(key)
    }
    return result
  } catch (error) {
    console.error('Failed to reach the main process dismissing a session', error)
    return 'unreachable'
  }
}

// Lets a rejected call reach the caller directly, rather than swallowing it the way send/stop/close do.
export async function setControls(sessionKey: SessionKey, patch: { readonly permissionMode?: SessionControls['permissionMode']; readonly model?: string; readonly effort?: SessionEffort | null }): Promise<SetControlsResult> {
  return invoke('session:controls:set', { sessionKey, ...patch })
}

export async function answerQuestion(sessionKey: SessionKey, permissionId: string, answers: Record<string, string>): Promise<QuestionAnswerResult> {
  return invoke('session:question:answer', { sessionKey, permissionId, answers })
}

export async function answerPlan(sessionKey: SessionKey, permissionId: string, decision: PlanDecision): Promise<PlanAnswerResult> {
  return invoke('session:plan:answer', { sessionKey, permissionId, decision })
}

export async function stopTask(sessionKey: SessionKey, taskId: string): Promise<SessionTaskStopResult> {
  return invoke('session:task:stop', { sessionKey, taskId })
}

export async function startFromTranscript(repoId: RepoId, sessionId: string, kind: 'resume' | 'fork'): Promise<void> {
  try {
    const result = await invoke('session:start', { target: { kind: 'transcript' }, mode: { kind, sessionId } })
    if (!result.ok && result.kind === 'folder-missing') {
      toast(folderMissingToast(result.path))
      return
    }
    handleStartResult(result)
  } catch (error) {
    console.error('Failed to reach the main process starting a session from a transcript', error)
  }
}
