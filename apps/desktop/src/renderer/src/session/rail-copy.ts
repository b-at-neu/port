// #103: every string the rail and the restore banner render — pure, no DOM.
// Window names and the reset clock reuse `startedClock` (`shared/hosting/
// label.ts`), the same "14:02 today, else Mon 14:02" rule the rail's own row
// meta line and the restore banner's "opened" line both need too.
import type { SessionRateLimit } from '../../../shared/hosting/types'
import type { UsageNotice } from './rail-model'
import { startedClock } from '../../../shared/hosting/label'

export const RAIL_TITLE = 'Sessions'
export const LIMIT_STEPPER_TITLE = "Each session is its own Claude Code process. They all share your subscription's usage limit."
export const NEW_SESSION_START = 'Start'
export const NEW_SESSION_NO_REPO = 'No ready repository to start in.'
export const CAPACITY_SET_FAILED = "Couldn't reach the main process. The limit wasn't changed."

export const RAIL_EMPTY_TITLE = 'No sessions yet.'
export const RAIL_EMPTY_HINT = 'Start one above, or with New session on a repository card.'

export const DISMISS_BUTTON = 'Dismiss'

const WINDOW_NAMES: Readonly<Record<'five-hour' | 'weekly' | 'weekly-opus' | 'weekly-sonnet' | 'overage' | 'unknown', string>> = {
  'five-hour': '5-hour',
  weekly: 'weekly',
  'weekly-opus': 'weekly Opus',
  'weekly-sonnet': 'weekly Sonnet',
  overage: 'extra usage',
  unknown: 'usage',
}

function windowName(window: SessionRateLimit['window']): string {
  return WINDOW_NAMES[window ?? 'unknown']
}

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`
}

function resetsSuffix(resetsAt: string | null, now: Date): string {
  return resetsAt === null ? '' : ` · resets ${startedClock(resetsAt, now)}`
}

export interface UsageNoticeLines {
  readonly main: string
  readonly sub: string
}

/** `warning` — "Nearing your <window> usage limit"; `rejected` — "<Window>
 *  usage limit reached". `· resets …` is omitted when there is no reset
 *  time. */
export function usageNoticeLines(notice: UsageNotice, now: Date): UsageNoticeLines {
  const window = windowName(notice.window)
  const resets = resetsSuffix(notice.resetsAt, now)
  if (notice.status === 'warning') {
    return { main: `⚠ Nearing your ${window} usage limit${resets}`, sub: 'Every open session draws on the same limit.' }
  }
  return { main: `⛔ ${capitalize(window)} usage limit reached${resets}`, sub: 'New turns in every session will fail until then.' }
}

/** A row's meta line: `started 14:02`, plus `· 1 permission waiting` when
 *  prompts are pending. */
export function rowMeta(startedClockText: string, pendingCount: number): string {
  const base = `started ${startedClockText}`
  if (pendingCount === 0) return base
  return `${base} · ${String(pendingCount)} permission${pendingCount === 1 ? '' : 's'} waiting`
}

export function restoreBannerLine(count: number): string {
  const verb = count === 1 ? 'was' : 'were'
  return `${String(count)} session${count === 1 ? '' : 's'} ${verb} open when Port last closed.`
}

export const RESTORE_RESUME_ALL = 'Resume all'
export const RESTORE_REVIEW = 'Review'
export const RESTORE_DISMISS = 'Dismiss'
export const RESTORE_FORGET = 'Forget'
export const RESTORE_RESUME_ONE = 'Resume'

export function restoreUnavailableLine(reason: string): string {
  return `This repository isn't ready — ${reason}`
}

export function restoreOpenedLine(startedAt: string, now: Date): string {
  return `opened ${startedClock(startedAt, now)}`
}

export function restorePartialLine(resumed: number, total: number, limit: number): string {
  return `Resumed ${String(resumed)} of ${String(total)} — the limit is ${String(limit)}. Raise it or close a session to resume the rest.`
}
