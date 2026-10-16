// Pure copy for the pin/archive row menu and its toasts (DESIGN §4: reversible actions toast with Undo).
import type { SessionMarkResult } from '@/types/hosting'

type MarkKind = 'pinned' | 'archived'

export function menuItemLabel(kind: MarkKind, on: boolean): string {
  if (kind === 'pinned') return on ? 'Unpin' : 'Pin'
  return on ? 'Unarchive' : 'Archive'
}

export const MENU_DISABLED_HINT = 'Available once the session has started'

export function markSuccessToast(kind: MarkKind, on: boolean): string {
  if (kind === 'pinned') return on ? 'Pinned.' : 'Unpinned.'
  return on ? "Archived. It's hidden from History." : 'Unarchived.'
}

export function markFailureToast(kind: MarkKind, result: Extract<SessionMarkResult, { ok: false }> | 'unreachable'): string {
  const verb = kind === 'pinned' ? 'pin' : 'archive'
  if (result === 'unreachable') return `Couldn't ${verb} the session: couldn't reach the main process.`
  return `Couldn't ${verb} the session: its id isn't valid.`
}

export const SESSION_ACTIONS_LABEL = 'Session actions'
export const RENAME_LABEL = 'Rename'
export const UNDO_LABEL = 'Undo'
