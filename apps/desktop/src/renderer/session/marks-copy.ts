// Pure copy for the pin/archive row menu and its toasts (DESIGN §4: reversible actions toast with Undo).
import type { SessionMarkResult } from '@/types/hosting'

type MarkKind = 'pinned' | 'archived'

export function menuItemLabel(kind: MarkKind, on: boolean): string {
  if (kind === 'pinned') return on ? 'Unpin' : 'Pin'
  return on ? 'Unarchive' : 'Archive'
}

export const MENU_DISABLED_HINT = 'Available once the session has started'

export function markSuccessToast(kind: MarkKind, on: boolean, closed = false): string {
  if (kind === 'pinned') return on ? 'Pinned.' : 'Unpinned.'
  if (!on) return 'Unarchived.'
  return closed ? "Archived and closed. It's hidden from History." : "Archived. It's hidden from History."
}

export const ARCHIVE_CONFIRM_PROMPT = 'Archive while Claude is working? The current turn is abandoned.'
export const ARCHIVE_CONFIRM_ACTION = 'Archive session'

export function markFailureToast(kind: MarkKind, result: Extract<SessionMarkResult, { ok: false }> | 'unreachable'): string {
  const verb = kind === 'pinned' ? 'pin' : 'archive'
  if (result === 'unreachable') return `Couldn't ${verb} the session: couldn't reach the main process.`
  return `Couldn't ${verb} the session: its id isn't valid.`
}

export const SESSION_ACTIONS_LABEL = 'Session actions'
export const RENAME_LABEL = 'Rename'
