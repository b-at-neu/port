// Session writes as shared hooks, plus the cross-screen entry points the sidebar, palette and keyboard map call directly.
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { openSession } from '@/renderer/router/navigation'
import { ipcQueryOptions } from '@/renderer/data/query'
import { invoke } from '@/renderer/data/invoke'
import { forgetTranscript } from '@/renderer/data/transcript'
import { perform } from '@/renderer/actions/perform'
import { useActionMutation } from '@/renderer/actions/use-action-mutation'
import type { RepoId } from '@/utils/repos'
import type { HostedSessionSnapshot, SessionKey, SessionMarks, SessionStartResult, WorktreeChoice } from '@/types/hosting'
import { orderSessions } from '@/utils/shell/session-order'
import type { ComposerAttachment } from '@/utils/hosting/attachments'
import type { FolderId } from '@/types/workspace'
import { CLOSE_BUTTON, CLOSE_CONFIRM_NO, CLOSE_CONFIRM_PROMPT, CLOSE_PENDING, ARCHIVE_PENDING, folderMissingToast } from '@/renderer/session/copy'
import { clearDraft, clearDraftAttachments } from '@/renderer/session/drafts'
import { closeToast, dismissToast, sendOutcome, startOutcome } from '@/renderer/session/outcomes'
import type { SendOutcome, StartInFolderOutcome } from '@/renderer/session/outcomes'

let queryClient: QueryClient | null = null

/** Called once from `main.ts`'s boot, the same seam `currentRepositories` there already uses. */
export function setSessionsQueryClient(client: QueryClient): void {
  queryClient = client
}

function sessionListKey() {
  return ipcQueryOptions('session.list').queryKey
}

function sessionMarksKey() {
  return ipcQueryOptions('session.marks').queryKey
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

/** Drops a dismissed session from every cache and draft that remembers it. */
export function forgetSession(client: QueryClient, key: SessionKey): void {
  const listKey = sessionListKey()
  const existing = client.getQueryData<readonly HostedSessionSnapshot[]>(listKey)
  if (existing !== undefined) {
    client.setQueryData(
      listKey,
      existing.filter((entry) => entry.sessionKey !== key),
    )
  }
  forgetTranscript(client, { kind: 'session', sessionKey: key })
  clearDraft(key)
  clearDraftAttachments(key)
}

export function liveSessionKeys(): readonly SessionKey[] {
  const sessions = queryClient?.getQueryData<readonly HostedSessionSnapshot[]>(sessionListKey()) ?? []
  const marks = queryClient?.getQueryData<SessionMarks>(sessionMarksKey())
  return orderSessions(sessions, marks).map((snapshot) => snapshot.sessionKey)
}

/** Adopts a started session and opens it, or opens the one that already holds the transcript. */
export function afterStart(result: SessionStartResult): void {
  if (result.ok) {
    adoptSession(result.snapshot)
    openSession(result.snapshot.sessionKey)
    return
  }
  if (result.kind === 'already-open') openSession(result.sessionKey)
}

/** The sidebar's own session row click, and the keyboard map's jump/next. */
export function selectSession(key: SessionKey): void {
  openSession(key)
}

export function useSendMessage() {
  const { perform: run, pending } = useActionMutation('session.send')
  async function send(key: SessionKey, text: string, attachments: readonly ComposerAttachment[] = []): Promise<SendOutcome> {
    return sendOutcome(await run({ sessionKey: key, text, attachments }))
  }
  return { send, pending }
}

/** The New session dialog's own start — the caller keeps the dialog open on a failed outcome so it can show the inline banner. */
export function useStartInFolder() {
  const { perform: run, pending } = useActionMutation('session.start')
  async function start(folderId: FolderId, worktree: boolean): Promise<StartInFolderOutcome> {
    const result = await run({ target: { kind: 'folder', folderId, worktree }, mode: { kind: 'fresh' } })
    const outcome = startOutcome(result)
    if (outcome.kind === 'started' && result !== 'unreachable') afterStart(result)
    return outcome
  }
  return { start, pending }
}

/** A streaming or interrupting session asks first; any other phase closes straight away. */
export function useCloseSession() {
  const { request, perform: run, confirmDialog } = useActionMutation('session.close', {
    confirm: () => ({ title: CLOSE_CONFIRM_PROMPT, confirmLabel: CLOSE_BUTTON, cancelLabel: CLOSE_CONFIRM_NO }),
    toast: { pending: CLOSE_PENDING, result: (result) => closeToast(result) },
  })
  async function close(key: SessionKey, options: { readonly confirm: boolean }): Promise<void> {
    if (options.confirm) request({ sessionKey: key })
    else await run({ sessionKey: key })
  }
  return { close, confirmDialog }
}

/** Dismisses with the given worktree choice; local state is cleared only on `ok`. */
export function useDismissSession() {
  const client = useQueryClient()
  const { perform: run } = useActionMutation('session.dismiss', {
    toast: { pending: ARCHIVE_PENDING, result: (result, input) => dismissToast(result, input.worktree) },
  })
  async function dismiss(key: SessionKey, choice: WorktreeChoice) {
    const result = await run({ sessionKey: key, worktree: choice })
    if (result !== 'unreachable' && result.ok) forgetSession(client, key)
    return result
  }
  return { dismiss }
}

/** History's Resume and Fork. */
export async function startFromTranscript(repoId: RepoId, sessionId: string, kind: 'resume' | 'fork'): Promise<void> {
  if (queryClient === null) return
  const result = await perform({ name: 'session.start', input: { target: { kind: 'transcript' }, mode: { kind, sessionId } } }, { invoke, client: queryClient })
  if (result === 'unreachable') return
  if (!result.ok && result.kind === 'folder-missing') {
    toast(folderMissingToast(result.path))
    return
  }
  afterStart(result)
}
