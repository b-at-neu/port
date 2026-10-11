import { describe, expect, it } from 'vitest'
import { restoreBannerLine, restoreOpenedLine, restorePartialLine, restoreUnavailableLine, usageNoticeLines } from './rail-copy'
import type { UsageNotice } from './rail-model'

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
