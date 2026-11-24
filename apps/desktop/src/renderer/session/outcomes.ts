// Pure mappers from a session write's result to the outcome or toast the operator sees.
import type { SessionCloseResult, SessionDismissResult, SessionMarkResult, SessionSendResult, SessionStartResult, SessionTaskStopResult, WorktreeChoice } from '@/types/hosting'
import type { RenderableStartFailure, StartFailureCopy } from '@/types/session'
import type { ActionToast } from '@/types/toast'
import { UNDO_LABEL } from '@/renderer/lib/copy'
import { ARCHIVE_UNAVAILABLE, archiveRemoveFailedToast, archiveSuccessToast, CLOSE_SUCCESS, CLOSE_UNKNOWN_SESSION, START_UNREACHABLE, startFailureCopy, TASK_STOP_SUCCESS, TASK_STOP_UNKNOWN, TASK_STOP_UNKNOWN_SESSION, taskStopFailed } from '@/renderer/session/copy'
import { markFailureToast, markSuccessToast } from '@/renderer/session/marks-copy'

export interface SendOutcome {
  readonly ok: boolean
  readonly error: string | null
  /** The blocked command's own name, set only when `error` is `'blocked-command'`. */
  readonly blockedCommandName: string | null
}

export type StartInFolderOutcome = { readonly kind: 'started' } | { readonly kind: 'failed'; readonly copy: StartFailureCopy; readonly result: RenderableStartFailure | null }

function plain(tone: ActionToast['tone'], title: string): ActionToast {
  return { tone, title, description: null, action: null, cancel: null }
}

export function sendOutcome(result: SessionSendResult | 'unreachable'): SendOutcome {
  if (result === 'unreachable') return { ok: false, error: 'unreachable', blockedCommandName: null }
  if (result.ok) return { ok: true, error: null, blockedCommandName: null }
  if (result.kind === 'blocked-command') return { ok: false, error: 'blocked-command', blockedCommandName: result.name }
  return { ok: false, error: 'unknown-session', blockedCommandName: null }
}

export function startOutcome(result: SessionStartResult | 'unreachable'): StartInFolderOutcome {
  if (result === 'unreachable') return { kind: 'failed', copy: { title: 'Could not start a session', body: START_UNREACHABLE, detail: null }, result: null }
  if (result.ok || result.kind === 'already-open') return { kind: 'started' }
  return { kind: 'failed', copy: startFailureCopy(result), result }
}

export function closeToast(result: SessionCloseResult): ActionToast {
  return result.ok ? plain('success', CLOSE_SUCCESS) : plain('error', CLOSE_UNKNOWN_SESSION)
}

/** `null` for a dirty worktree: the archive dialog reopens instead of toasting. */
export function dismissToast(result: SessionDismissResult, choice: WorktreeChoice): ActionToast | null {
  if (result.ok) return plain('success', archiveSuccessToast(choice))
  if (result.kind === 'worktree-dirty') return null
  return plain('error', result.kind === 'worktree-remove-failed' ? archiveRemoveFailedToast(result.message) : ARCHIVE_UNAVAILABLE)
}

export function taskStopToast(result: SessionTaskStopResult): ActionToast {
  if (result.ok) return plain('success', TASK_STOP_SUCCESS)
  if (result.kind === 'unknown-task') return plain('info', TASK_STOP_UNKNOWN)
  if (result.kind === 'stop-failed') return plain('error', taskStopFailed(result.message))
  return plain('error', TASK_STOP_UNKNOWN_SESSION)
}

export function markToast(kind: 'pinned' | 'archived', on: boolean, result: SessionMarkResult, undo: () => void): ActionToast {
  if (!result.ok) return plain('error', markFailureToast(kind))
  return { ...plain('success', markSuccessToast(kind, on)), action: { label: UNDO_LABEL, onClick: undo } }
}
