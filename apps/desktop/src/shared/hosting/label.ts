// The one session display label and started-at clock, shared by the rail and the permission dialog, so both never name a session differently. Pure, renderer-safe.
import type { SessionOrigin } from './types'

/** The first 8 characters of a Claude session id, matching the header's own short id. */
function short(id: string): string {
  return id.slice(0, 8)
}

/** What a session shows when it has no `title` yet — before the first
 *  prompt (fresh) or before a resume/fork's own title lookup resolved. */
function fallbackLabel(origin: SessionOrigin): string {
  switch (origin.kind) {
    case 'fresh':
      return 'New session'
    case 'resumed':
      return `Resumed session ${short(origin.from)}`
    case 'forked':
      return `Fork of ${short(origin.from)}`
  }
}

export interface SessionLabelInput {
  readonly title: string | null
  readonly origin: SessionOrigin
}

// A session's own display title, with no repo label in front of it.
export function sessionTitle(session: SessionLabelInput): string {
  return session.title ?? fallbackLabel(session.origin)
}

/** `<repo> · <title>` — the one label function every consumer imports, rather than assembling its own version. */
export function sessionDisplayLabel(session: SessionLabelInput, repoLabel: string): string {
  return `${repoLabel} · ${sessionTitle(session)}`
}

/** `14:02` same calendar day, else `Mon 14:02`; always `h23` so a mixed 12-/24-hour rail never reads as two different clocks. */
export function startedClock(startedAt: string, now: Date): string {
  const started = new Date(startedAt)
  const sameDay = started.getFullYear() === now.getFullYear() && started.getMonth() === now.getMonth() && started.getDate() === now.getDate()
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).format(started)
  if (sameDay) return time
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(started)
  return `${weekday} ${time}`
}
