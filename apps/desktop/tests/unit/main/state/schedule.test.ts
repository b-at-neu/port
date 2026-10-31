import { describe, expect, it } from 'vitest'
import { BACKOFF_CEILING_MS, SOURCE_BASE_INTERVAL_MS, initialHealth } from '@/types/board'
import type { SourceHealth } from '@/types/board'
import { afterFailure, afterSuccess, budgetedIntervalMs, deferredUntil, dueSources, nextDueAt } from '@/main/state/schedule'

const NOW = new Date('2026-01-01T00:10:00.000Z')

describe('nextDueAt', () => {
  it('a source that has never attempted a read is due immediately', () => {
    expect(nextDueAt(initialHealth('denials'), NOW).getTime()).toBeLessThanOrEqual(NOW.getTime())
  })

  it('a deferred source is due at deferredUntil, not the interval math', () => {
    const health: SourceHealth = { ...initialHealth('github'), lastAttemptAt: NOW.toISOString(), deferredUntil: '2026-01-01T01:00:00.000Z' }
    expect(nextDueAt(health, NOW).toISOString()).toBe('2026-01-01T01:00:00.000Z')
  })
})

describe('afterSuccess / afterFailure', () => {
  it('doubles the interval on failure, capped at the ceiling', () => {
    let health = initialHealth('github')
    for (let i = 0; i < 20; i++) {
      health = afterFailure(health, 'github', NOW, 'boom')
    }
    expect(health.intervalMs).toBe(BACKOFF_CEILING_MS)
  })

  it('resets to base interval on the first success', () => {
    let health = afterFailure(initialHealth('github'), 'github', NOW, 'boom')
    health = afterFailure(health, 'github', NOW, 'boom')
    expect(health.intervalMs).toBeGreaterThan(SOURCE_BASE_INTERVAL_MS.github)
    health = afterSuccess(health, 'github', NOW)
    expect(health.intervalMs).toBe(SOURCE_BASE_INTERVAL_MS.github)
    expect(health.consecutiveFailures).toBe(0)
    expect(health.lastError).toBeNull()
  })
})

describe('budgetedIntervalMs', () => {
  const window = { cost: 5, remaining: 4999, resetAt: '2026-01-01T01:00:00.000Z', limit: 5000 }

  it('a cheap poll keeps the base interval', () => {
    expect(budgetedIntervalMs({ costs: [5], rateLimit: window, now: NOW })).toBe(SOURCE_BASE_INTERVAL_MS.github)
  })

  it('an expensive poll stretches to its share of the hourly limit', () => {
    expect(budgetedIntervalMs({ costs: [146], rateLimit: window, now: NOW })).toBe(210_240)
  })

  it('every repository counts against the one budget', () => {
    expect(budgetedIntervalMs({ costs: [50, 50, 50], rateLimit: window, now: NOW })).toBe(216_000)
  })

  it('low headroom near the reset stretches past the share', () => {
    expect(budgetedIntervalMs({ costs: [5], rateLimit: { ...window, remaining: 300 }, now: NOW })).toBe(150_000)
  })

  it('is capped at the backoff ceiling', () => {
    expect(budgetedIntervalMs({ costs: [5], rateLimit: { ...window, remaining: 201 }, now: NOW })).toBe(BACKOFF_CEILING_MS)
  })

  it('an unreadable limit reads as 5,000', () => {
    expect(budgetedIntervalMs({ costs: [146], rateLimit: { ...window, limit: 0 }, now: NOW })).toBe(210_240)
  })

  it('no positive known cost keeps the base interval', () => {
    expect(budgetedIntervalMs({ costs: [], rateLimit: window, now: NOW })).toBe(SOURCE_BASE_INTERVAL_MS.github)
    expect(budgetedIntervalMs({ costs: [0], rateLimit: window, now: NOW })).toBe(SOURCE_BASE_INTERVAL_MS.github)
  })

  it('a reset already past adds no headroom term', () => {
    expect(budgetedIntervalMs({ costs: [5], rateLimit: { ...window, remaining: 300, resetAt: '2026-01-01T00:00:00.000Z' }, now: NOW })).toBe(SOURCE_BASE_INTERVAL_MS.github)
  })
})

describe('deferredUntil', () => {
  it('a rate-limited failure defers to resetAt rather than doubling', () => {
    const rateLimit = { cost: 1, remaining: 500, resetAt: '2026-01-01T02:00:00.000Z', limit: 5000 }
    expect(deferredUntil(rateLimit, 'rate-limited')).toBe('2026-01-01T02:00:00.000Z')
  })

  it('remaining under the floor defers even on an otherwise-ok read', () => {
    const rateLimit = { cost: 1, remaining: 50, resetAt: '2026-01-01T02:00:00.000Z', limit: 5000 }
    expect(deferredUntil(rateLimit, null)).toBe('2026-01-01T02:00:00.000Z')
  })

  it('an ordinary failure with headroom to spare defers to nothing', () => {
    const rateLimit = { cost: 1, remaining: 4999, resetAt: '2026-01-01T02:00:00.000Z', limit: 5000 }
    expect(deferredUntil(rateLimit, 'network')).toBeNull()
  })

  it('no rate-limit window at all defers to nothing', () => {
    expect(deferredUntil(null, 'network')).toBeNull()
  })
})

describe('dueSources', () => {
  it('orders github last even when every source is due', () => {
    const health = { github: initialHealth('github'), sessions: initialHealth('sessions'), worktrees: initialHealth('worktrees'), denials: initialHealth('denials') }
    expect(dueSources(health, NOW)).toEqual(['sessions', 'worktrees', 'denials', 'github'])
  })

  it('a source not yet due is excluded', () => {
    const fresh = afterSuccess(initialHealth('worktrees'), 'worktrees', NOW)
    const health = { github: initialHealth('github'), sessions: initialHealth('sessions'), worktrees: fresh, denials: initialHealth('denials') }
    expect(dueSources(health, NOW)).toEqual(['sessions', 'denials', 'github'])
  })
})
