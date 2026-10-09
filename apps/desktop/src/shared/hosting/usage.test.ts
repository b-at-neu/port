import { describe, expect, it } from 'vitest'
import { aggregateUsage, contextPercent, formatCost, formatTokens } from './usage'
import type { SessionUsage } from './usage'

const OBSERVED_AT = '2026-01-05T12:00:00.000Z'

function usage(partial: Partial<SessionUsage> = {}): SessionUsage {
  return {
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    contextTokens: null,
    contextWindow: null,
    observedAt: OBSERVED_AT,
    ...partial,
  }
}

describe('aggregateUsage', () => {
  it('reports null costUsd and totalTokens, and zero sessions, with no readings', () => {
    expect(aggregateUsage([])).toEqual({ costUsd: null, totalTokens: null, sessions: 0 })
    expect(aggregateUsage([null, null])).toEqual({ costUsd: null, totalTokens: null, sessions: 0 })
  })

  it('sums only snapshots with non-null usage', () => {
    const result = aggregateUsage([usage({ costUsd: 0.5, inputTokens: 100, outputTokens: 50 }), null, usage({ costUsd: 1, inputTokens: 200 })])
    expect(result).toEqual({ costUsd: 1.5, totalTokens: 350, sessions: 2 })
  })

  it('counts sessions with usage but no cost as unknown cost, never zero', () => {
    const result = aggregateUsage([usage({ inputTokens: 10 })])
    expect(result.costUsd).toBeNull()
    expect(result.totalTokens).toBe(10)
    expect(result.sessions).toBe(1)
  })
})

describe('contextPercent', () => {
  it('returns null for a null usage', () => {
    expect(contextPercent(null)).toBeNull()
  })

  it('returns null when either side is unknown', () => {
    expect(contextPercent(usage({ contextTokens: null, contextWindow: 200_000 }))).toBeNull()
    expect(contextPercent(usage({ contextTokens: 100, contextWindow: null }))).toBeNull()
  })

  it('returns null when the window is not positive', () => {
    expect(contextPercent(usage({ contextTokens: 100, contextWindow: 0 }))).toBeNull()
  })

  it('computes a rounded, clamped percentage', () => {
    expect(contextPercent(usage({ contextTokens: 84_000, contextWindow: 200_000 }))).toBe(42)
    expect(contextPercent(usage({ contextTokens: 250_000, contextWindow: 200_000 }))).toBe(100)
  })
})

describe('formatCost', () => {
  it('formats unknown as an em dash', () => {
    expect(formatCost(null)).toBe('—')
  })

  it('formats a positive value under a cent as <$0.01', () => {
    expect(formatCost(0.004)).toBe('<$0.01')
  })

  it('formats zero as $0.00', () => {
    expect(formatCost(0)).toBe('$0.00')
  })

  it('formats an ordinary value to two decimals', () => {
    expect(formatCost(0.92)).toBe('$0.92')
    expect(formatCost(1.8449)).toBe('$1.84')
  })
})

describe('formatTokens', () => {
  it('formats unknown as an em dash', () => {
    expect(formatTokens(null)).toBe('—')
  })

  it('formats below 1000 as a rounded integer', () => {
    expect(formatTokens(950)).toBe('950')
  })

  it('formats thousands with one decimal, trimmed', () => {
    expect(formatTokens(12_300)).toBe('12.3k')
    expect(formatTokens(10_000)).toBe('10k')
  })

  it('formats millions with one decimal, trimmed', () => {
    expect(formatTokens(1_200_000)).toBe('1.2M')
    expect(formatTokens(2_000_000)).toBe('2M')
  })
})
