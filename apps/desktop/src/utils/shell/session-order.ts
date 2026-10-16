// The one session ordering rule — pinned sessions first, then the rest, each group in list
// order — shared by the sidebar, the keymap and the main-process menu so all three always agree.
// Imports types only, so this is renderer-safe.
import type { HostedSessionSnapshot, SessionMarks } from '@/types/hosting'

/** Ctrl/Cmd+1…9's own cap — also the menu's "Go to session" submenu size. */
export const MAX_JUMP_SESSIONS = 9

function isPinned(session: HostedSessionSnapshot, marks: SessionMarks | undefined): boolean {
  return session.claudeSessionId !== null && (marks?.pinned.includes(session.claudeSessionId) ?? false)
}

/** User sessions only (`phase !== 'ended' && stage === null`) — stage sessions never appear here.
 *  Pinned ones come first, then the rest, each group keeping `sessions`' own order. Undefined
 *  `marks` (not loaded yet) leaves the plain list order unchanged. */
export function orderSessions(sessions: readonly HostedSessionSnapshot[], marks: SessionMarks | undefined): readonly HostedSessionSnapshot[] {
  const live = sessions.filter((session) => session.phase !== 'ended' && session.stage === null)
  if (marks === undefined) return live
  return [...live.filter((session) => isPinned(session, marks)), ...live.filter((session) => !isPinned(session, marks))]
}
