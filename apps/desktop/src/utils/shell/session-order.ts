// The one session ordering rule, shared by the sidebar, the keymap and the main-process menu.
// Imports types only, so this is renderer-safe.
import type { HostedSessionSnapshot, SessionMarks } from '@/types/hosting'

/** Ctrl/Cmd+1…9's own cap — also the menu's "Go to session" submenu size. */
export const MAX_JUMP_SESSIONS = 9

function isPinned(session: HostedSessionSnapshot, marks: SessionMarks | undefined): boolean {
  return session.claudeSessionId !== null && (marks?.pinned.includes(session.claudeSessionId) ?? false)
}

function isLiveUserSession(session: HostedSessionSnapshot): boolean {
  return session.phase !== 'ended' && session.stage === null
}

/** The open user session for a Claude session id, or null — pipeline stage sessions never match. */
export function liveUserSession(sessions: readonly HostedSessionSnapshot[], claudeSessionId: string): HostedSessionSnapshot | null {
  return sessions.find((session) => isLiveUserSession(session) && session.claudeSessionId === claudeSessionId) ?? null
}

/** User sessions only, pinned ones first, each group keeping `sessions`' own order. Undefined
 *  `marks` (not loaded yet) leaves the plain list order unchanged. */
export function orderSessions(sessions: readonly HostedSessionSnapshot[], marks: SessionMarks | undefined): readonly HostedSessionSnapshot[] {
  const live = sessions.filter(isLiveUserSession)
  if (marks === undefined) return live
  return [...live.filter((session) => isPinned(session, marks)), ...live.filter((session) => !isPinned(session, marks))]
}
