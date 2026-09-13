// The polling policy (#80 Decision 2) — pure, clock passed in, no timer of
// its own. `watcher.ts` is the only file under `src/main/` allowed to name
// one; this module only ever answers "when is X next due" and "how does a
// read change X's health".
import { BACKOFF_CEILING_MS, RATE_LIMIT_FLOOR, SOURCE_BASE_INTERVAL_MS, SOURCE_KINDS } from '../../shared/board/types'
import type { SourceHealth, SourceKind } from '../../shared/board/types'
import type { RateLimitInfo } from '../../shared/github/types'

/** The instant this source is next allowed to run. A source with no prior
 *  attempt (`lastAttemptAt: null`) is due immediately — "never succeeded"
 *  must never be read as "just succeeded". `deferredUntil` (a rate-limit
 *  deferral) always wins over the interval math, since a known reset instant
 *  beats a doubled guess. */
export function nextDueAt(health: SourceHealth, now: Date): Date {
  if (health.deferredUntil !== null) return new Date(health.deferredUntil)
  if (health.lastAttemptAt === null) return now
  const lastAttempt = Date.parse(health.lastAttemptAt)
  if (Number.isNaN(lastAttempt)) return now
  return new Date(lastAttempt + health.intervalMs)
}

/** A successful read resets the interval to base and clears every failure
 *  signal (Decision 4 — "resets to base on the first success"). */
export function afterSuccess(health: SourceHealth, kind: SourceKind, at: Date): SourceHealth {
  const iso = at.toISOString()
  return { lastSuccessAt: iso, lastAttemptAt: iso, consecutiveFailures: 0, lastError: null, intervalMs: SOURCE_BASE_INTERVAL_MS[kind], deferredUntil: null }
}

/** Doubles the interval, capped at `BACKOFF_CEILING_MS`, and never touches
 *  `lastSuccessAt` — the last good value is a data question, this is a
 *  health question (Decision 4). `deferUntil` carries a rate-limit deferral
 *  computed by `deferredUntil` below; `null` clears any previous deferral a
 *  now-ordinary failure no longer justifies. */
export function afterFailure(health: SourceHealth, kind: SourceKind, at: Date, message: string, deferUntil: string | null = null): SourceHealth {
  return {
    lastSuccessAt: health.lastSuccessAt,
    lastAttemptAt: at.toISOString(),
    consecutiveFailures: health.consecutiveFailures + 1,
    lastError: message,
    intervalMs: Math.min(health.intervalMs * 2, BACKOFF_CEILING_MS),
    deferredUntil: deferUntil,
  }
}

/** A known reset instant always beats a doubled guess (Decision 4) — set
 *  whenever the failure itself was `rate-limited`, or the rate-limit window
 *  already reports `remaining` under the floor even on an otherwise-ok read. */
export function deferredUntil(rateLimit: RateLimitInfo | null, failureKind: string | null): string | null {
  if (rateLimit === null) return null
  if (failureKind === 'rate-limited' || rateLimit.remaining < RATE_LIMIT_FLOOR) return rateLimit.resetAt
  return null
}

/** Every source due at `now`, GitHub last — a cheap local read is never
 *  queued behind an expensive one. */
export function dueSources(health: Readonly<Record<SourceKind, SourceHealth>>, now: Date): readonly SourceKind[] {
  const due = SOURCE_KINDS.filter((kind) => nextDueAt(health[kind], now).getTime() <= now.getTime())
  return [...due].sort((a, b) => (a === 'github' ? 1 : b === 'github' ? -1 : 0))
}
