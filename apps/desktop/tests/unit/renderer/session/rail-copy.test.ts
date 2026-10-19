import { describe, expect, it } from 'vitest'
import { CONTEXT_METER_LABEL, contextMeterLabel, restoreBannerLine, restoreOpenedLine, restorePartialLine, restoreUnavailableLine, usageNoticeLines, usageSessionsLine, usageValue } from '@/renderer/session/rail-copy'
import type { UsageNotice } from '@/types/session'
import type { SessionUsage } from '@/utils/hosting/usage'

const NOW = new Date(2026, 0, 5, 12, 0)

describe('usageNoticeLines', () => {
  it('renders the warning wording with a reset time', () => {
    const notice: UsageNotice = { status: 'warning', window: 'five-hour', resetsAt: new Date(2026, 0, 5, 16, 0).toISOString() }
    const lines = usageNoticeLines(notice, NOW)
    expect(lines.main).toContain('Nearing your 5-hour usage limit')
    expect(lines.main).toContain('resets')
    expect(lines.sub).toBe('Every open session draws on the same limit.')
  })

  it('renders the rejected wording with the window capitalized', () => {
    const notice: UsageNotice = { status: 'rejected', window: 'weekly-opus', resetsAt: null }
    const lines = usageNoticeLines(notice, NOW)
    expect(lines.main).toBe('⛔ Weekly Opus usage limit reached')
    expect(lines.sub).toBe('New turns in every session will fail until then.')
  })

  it('omits the resets suffix when there is no reset time', () => {
    const notice: UsageNotice = { status: 'warning', window: null, resetsAt: null }
    expect(usageNoticeLines(notice, NOW).main).not.toContain('resets')
  })

  it('falls back to "usage" for an unrecognised window', () => {
    const notice: UsageNotice = { status: 'warning', window: null, resetsAt: null }
    expect(usageNoticeLines(notice, NOW).main).toContain('usage limit')
  })
})

describe('restoreBannerLine', () => {
  it('pluralizes the session count', () => {
    expect(restoreBannerLine(1)).toBe('1 session was open when Port last closed.')
    expect(restoreBannerLine(2)).toBe('2 sessions were open when Port last closed.')
  })
})

describe('restoreUnavailableLine', () => {
  it('names the reason', () => {
    expect(restoreUnavailableLine('its folder is gone')).toBe("This repository isn't ready — its folder is gone")
  })
})

describe('restoreOpenedLine', () => {
  it('renders the opened clock', () => {
    expect(restoreOpenedLine(new Date(2026, 0, 5, 18, 40).toISOString(), NOW)).toBe('opened 18:40')
  })
})

describe('restorePartialLine', () => {
  it('names how many resumed against the limit', () => {
    expect(restorePartialLine(3, 5, 3)).toBe('Resumed 3 of 5 — the limit is 3. Raise it or close a session to resume the rest.')
  })
})

describe('usageValue', () => {
  it('renders cost and tokens', () => {
    expect(usageValue({ costUsd: 0.42, totalTokens: 210_000, sessions: 1 })).toBe('$0.42 · 210k tokens')
  })

  it('renders dashes for nulls', () => {
    expect(usageValue({ costUsd: null, totalTokens: null, sessions: 0 })).toBe('— · — tokens')
  })
})

describe('usageSessionsLine', () => {
  it('pluralizes', () => {
    expect(usageSessionsLine(1)).toBe('1 session with a reading')
    expect(usageSessionsLine(2)).toBe('2 sessions with a reading')
  })
})

describe('CONTEXT_METER_LABEL', () => {
  it('names the meter as context usage', () => {
    expect(CONTEXT_METER_LABEL).toBe('Context')
  })
})

describe('contextMeterLabel', () => {
  const usage: SessionUsage = { costUsd: 0.42, inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1, contextTokens: 84_000, contextWindow: 200_000, observedAt: 't0' }

  it('renders known usage', () => {
    expect(contextMeterLabel(usage)).toBe('84k of 200k tokens in context')
  })

  it('renders the unknown label for null usage', () => {
    expect(contextMeterLabel(null)).toBe('No context reading yet.')
  })

  it('renders the unknown label when the context window is not positive', () => {
    expect(contextMeterLabel({ ...usage, contextWindow: 0 })).toBe('No context reading yet.')
  })
})
