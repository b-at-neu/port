// #103: pure `readRateLimit(message, observedAt)` — narrows a rate limit
// event structurally rather than importing the SDK's own event type (the
// envelope crosses the boundary as `message: unknown`, and this app owns
// every narrowing decision on it, the same rule #219's project.ts already
// follows). `utilization` is deliberately never read: its unit is
// undocumented in SDK 0.3.261, and a percentage in the wrong unit is
// misinformation an operator would act on.
import type { SessionRateLimit } from '../../shared/hosting/types'

const STATUS_MAP: Readonly<Record<string, SessionRateLimit['status'] | undefined>> = {
  allowed: 'allowed',
  allowed_warning: 'warning',
  rejected: 'rejected',
}

const WINDOW_MAP: Readonly<Record<string, SessionRateLimit['window']>> = {
  five_hour: 'five-hour',
  seven_day: 'weekly',
  seven_day_overage_included: 'weekly',
  seven_day_opus: 'weekly-opus',
  seven_day_sonnet: 'weekly-sonnet',
  overage: 'overage',
}

/** A finite number below `1e11` reads as epoch seconds (a millisecond epoch
 *  for a plausible near-term date is always well above that), otherwise
 *  milliseconds — the same disambiguation `main/hosting/classify.ts`'s own
 *  numeric-field readers use elsewhere in this app. */
function resetsAtFrom(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const millis = value < 1e11 ? value * 1000 : value
  const date = new Date(millis)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** `null` on anything that is not a `rate_limit_event`, or whose `status`
 *  this app does not recognise — leaving the previous reading in place is
 *  the caller's job (`handle.ts`'s `applyMessage`), never this function's. */
export function readRateLimit(message: unknown, observedAt: string): SessionRateLimit | null {
  if (typeof message !== 'object' || message === null) return null
  const envelope = message as Record<string, unknown>
  if (envelope.type !== 'rate_limit_event') return null
  const info = envelope.rate_limit_info
  if (typeof info !== 'object' || info === null) return null
  const infoRecord = info as Record<string, unknown>

  const status = typeof infoRecord.status === 'string' ? STATUS_MAP[infoRecord.status] : undefined
  if (status === undefined) return null

  const rateLimitType = infoRecord.rateLimitType
  const window = typeof rateLimitType === 'string' ? (WINDOW_MAP[rateLimitType] ?? null) : null

  return { status, window, resetsAt: resetsAtFrom(infoRecord.resetsAt), observedAt }
}
