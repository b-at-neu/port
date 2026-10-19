// Pure, clock passed in, no timer of its own — this module only ever answers "when is X next due" and "how does a read change X's health".
import { BACKOFF_CEILING_MS, BUDGET_SHARE, DEFAULT_GRAPHQL_LIMIT, RATE_LIMIT_FLOOR, SOURCE_BASE_INTERVAL_MS, SOURCE_KINDS } from '@/types/board'
import type { SourceHealth, SourceKind } from '@/types/board'
import type { RateLimitInfo } from '@/types/github'

/** A source with no prior attempt is due immediately. `deferredUntil` always wins over the interval math, since a known reset instant beats a doubled guess. */
export function nextDueAt(health: SourceHealth, now: Date): Date {
  if (health.deferredUntil !== null) return new Date(health.deferredUntil)
  if (health.lastAttemptAt === null) return now
  const lastAttempt = Date.parse(health.lastAttemptAt)
  if (Number.isNaN(lastAttempt)) return now
  return new Date(lastAttempt + health.intervalMs)
}

/** A successful read resets the interval to base and clears every failure signal. */
export function afterSuccess(health: SourceHealth, kind: SourceKind, at: Date): SourceHealth {
  const iso = at.toISOString()
  return { lastSuccessAt: iso, lastAttemptAt: iso, consecutiveFailures: 0, lastError: null, intervalMs: SOURCE_BASE_INTERVAL_MS[kind], deferredUntil: null }
}

/** Doubles the interval, capped at `BACKOFF_CEILING_MS`; never touches `lastSuccessAt`, since that is a data question, this a health one. */
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

interface BudgetedIntervalParams {
  /** The latest successful `rateLimit.cost` of every ready repository. */
  readonly costs: readonly number[]
  readonly rateLimit: RateLimitInfo
  readonly now: Date
}

const HOUR_MS = 3_600_000

/** The GitHub interval that keeps projected hourly use, across every repository, under `BUDGET_SHARE` of the limit, and that spreads the headroom left above the floor over the time until reset. Base when no positive cost is known. */
export function budgetedIntervalMs(params: BudgetedIntervalParams): number {
  const total = params.costs.reduce((sum, cost) => sum + Math.max(0, cost), 0)
  if (total <= 0) return SOURCE_BASE_INTERVAL_MS.github
  const limit = params.rateLimit.limit > 0 ? params.rateLimit.limit : DEFAULT_GRAPHQL_LIMIT
  const shareMs = (HOUR_MS * total) / (BUDGET_SHARE * limit)
  const msUntilReset = Date.parse(params.rateLimit.resetAt) - params.now.getTime()
  const headroom = params.rateLimit.remaining - RATE_LIMIT_FLOOR
  const headroomMs = msUntilReset > 0 && headroom > 0 ? (msUntilReset * total) / headroom : 0
  return Math.min(BACKOFF_CEILING_MS, Math.max(SOURCE_BASE_INTERVAL_MS.github, shareMs, headroomMs))
}

/** Set whenever the failure was `rate-limited`, or the rate-limit window already reports `remaining` under the floor on an otherwise-ok read. */
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
