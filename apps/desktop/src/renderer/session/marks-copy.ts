// Pure copy for the pin/archive row menu and its toasts (DESIGN §4: reversible actions toast with Undo).
type MarkKind = 'pinned' | 'archived'

export function menuItemLabel(kind: MarkKind, on: boolean): string {
  if (kind === 'pinned') return on ? 'Unpin' : 'Pin'
  return on ? 'Unarchive' : 'Archive'
}

export const MENU_DISABLED_HINT = 'Available once the session has started'

export function markPendingToast(kind: MarkKind): string {
  return kind === 'pinned' ? 'Updating the pin…' : 'Updating the archive…'
}

export function markSuccessToast(kind: MarkKind, on: boolean): string {
  if (kind === 'pinned') return on ? 'Pinned.' : 'Unpinned.'
  return on ? "Archived. It's hidden from History." : 'Unarchived.'
}

export const ARCHIVE_CONFIRM_PROMPT = 'Archive while Claude is working? The current turn is abandoned.'
export const ARCHIVE_CONFIRM_ACTION = 'Archive session'

export function markFailureToast(kind: MarkKind): string {
  return `Couldn't ${kind === 'pinned' ? 'pin' : 'archive'} the session: its id isn't valid.`
}

export const SESSION_ACTIONS_LABEL = 'Session actions'
export const RENAME_LABEL = 'Rename'
