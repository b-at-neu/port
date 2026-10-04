// #103: the one session display label and started-at clock, shared by the
// rail (`renderer/src/session/rail.ts`) and the permission dialog
// (`renderer/src/permission/controller.ts`) — a `guard(#103)` pin in
// `scripts/checks/desktop-hosting.ts` fails if either consumer stops
// importing this function, or if a second declaration of it appears
// anywhere else. If the dialog and the rail named a session differently, the
// operator would have no reliable way to tell which session a prompt
// belongs to. Pure, renderer-safe: no DOM, no Node builtin.
import type { SessionOrigin } from './types'

/** The first 8 characters of a Claude session id — the same truncation
 *  `session/view.ts`'s own `shortId` already uses for the header's short id. */
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

/** `<repo> · <title>` — the one label function every consumer of a hosted
 *  session's display name imports, rather than assembling its own version. */
export function sessionDisplayLabel(session: SessionLabelInput, repoLabel: string): string {
  const title = session.title ?? fallbackLabel(session.origin)
  return `${repoLabel} · ${title}`
}

/** `14:02` for a `startedAt` that falls on the same calendar day as `now`,
 *  else `Mon 14:02` — both via `Intl.DateTimeFormat`, respecting the
 *  operator's own locale for digit and weekday shape but always `h23`
 *  (24-hour, no AM/PM) since every clock in this ticket's own UX states is
 *  written that way, and a mixed 12-/24-hour rail would read as two
 *  different clocks. */
export function startedClock(startedAt: string, now: Date): string {
  const started = new Date(startedAt)
  const sameDay = started.getFullYear() === now.getFullYear() && started.getMonth() === now.getMonth() && started.getDate() === now.getDate()
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).format(started)
  if (sameDay) return time
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(started)
  return `${weekday} ${time}`
}
