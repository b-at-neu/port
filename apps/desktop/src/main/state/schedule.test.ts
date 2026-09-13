import { describe, expect, it } from 'vitest'
import { BACKOFF_CEILING_MS, SOURCE_BASE_INTERVAL_MS, initialHealth } from '../../shared/board/types'
import type { SourceHealth } from '../../shared/board/types'
import { afterFailure, afterSuccess, deferredUntil, dueSources, nextDueAt } from './schedule'

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

describe('deferredUntil', () => {
  it('a rate-limited failure defers to resetAt rather than doubling', () => {
    const rateLimit = { cost: 1, remaining: 500, resetAt: '2026-01-01T02:00:00.000Z' }
    expect(deferredUntil(rateLimit, 'rate-limited')).toBe('2026-01-01T02:00:00.000Z')
  })

  it('remaining under the floor defers even on an otherwise-ok read', () => {
    const rateLimit = { cost: 1, remaining: 50, resetAt: '2026-01-01T02:00:00.000Z' }
    expect(deferredUntil(rateLimit, null)).toBe('2026-01-01T02:00:00.000Z')
  })

  it('an ordinary failure with headroom to spare defers to nothing', () => {
    const rateLimit = { cost: 1, remaining: 4999, resetAt: '2026-01-01T02:00:00.000Z' }
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
