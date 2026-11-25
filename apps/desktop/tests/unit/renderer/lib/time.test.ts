import { describe, expect, it } from 'vitest'
import { exactTime, formatAgo, formatAgoSeconds, formatAgoSince, formatClock, formatDuration, formatHourMinute, formatMonthDay, formatShortClock, formatShortTime, formatTimeOfDay, relativeTime } from '@/renderer/lib/time'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('relativeTime', () => {
  it.each([
    [5_000, 'just now'],
    [-5_000, 'just now'],
    [MIN, '1 minute ago'],
    [2 * MIN, '2 minutes ago'],
    [HOUR, '1 hour ago'],
    [2 * HOUR, '2 hours ago'],
    [DAY, '1 day ago'],
    [3 * DAY, '3 days ago'],
  ])('%d ms reads %s', (ms, expected) => {
    expect(relativeTime(ms)).toBe(expected)
  })
})

describe('formatAgo', () => {
  it.each([
    [-1_000, 'just now'],
    [59_000, 'just now'],
    [60_000, '1m ago'],
    [59 * MIN, '59m ago'],
    [60 * MIN, '1h ago'],
    [23 * HOUR, '23h ago'],
    [24 * HOUR, '1d ago'],
  ])('%d ms reads %s', (ms, expected) => {
    expect(formatAgo(ms)).toBe(expected)
  })
})

describe('formatAgoSeconds', () => {
  it.each([
    [Number.NaN, 'just now'],
    [-1, 'just now'],
    [0, '0s ago'],
    [59_400, '59s ago'],
    [59_600, '1m ago'],
    [89_000, '1m ago'],
    [59 * MIN, '59m ago'],
    [90 * MIN, '2h ago'],
    [25 * HOUR, '25h ago'],
  ])('%d ms reads %s', (ms, expected) => {
    expect(formatAgoSeconds(ms)).toBe(expected)
  })
})

describe('formatShortTime', () => {
  it('is the locale clock with a padded hour and minute', () => {
    const date = new Date(2026, 0, 1, 9, 5)
    expect(formatShortTime(date.toISOString())).toBe(date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
  })

  it('returns an unparsable string as it came', () => {
    expect(formatShortTime('not a date')).toBe('not a date')
  })
})

describe('formatAgoSince', () => {
  const now = new Date('2026-01-01T12:00:00Z')
  it.each([
    [-MIN, 'just now'],
    [59_000, 'just now'],
    [5 * MIN, '5m ago'],
    [59 * MIN, '59m ago'],
    [HOUR, '1h ago'],
    [23 * HOUR, '23h ago'],
    [50 * HOUR, '2d ago'],
  ])('%d ms before now reads %s', (agoMs, expected) => {
    expect(formatAgoSince(new Date(now.getTime() - agoMs).toISOString(), now)).toBe(expected)
  })
})

describe('formatDuration', () => {
  it.each([
    [-MIN, '<1m'],
    [30_000, '<1m'],
    [12 * MIN, '12m'],
    [59 * MIN, '59m'],
    [HOUR, '1h 0m'],
    [64 * MIN, '1h 4m'],
    [DAY, '1d 0h'],
    [2 * DAY + 3 * HOUR, '2d 3h'],
  ])('%d ms reads %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected)
  })
})

describe('formatClock', () => {
  it('has no weekday on the same calendar day', () => {
    const now = new Date(2026, 0, 5, 20, 0)
    expect(formatClock(new Date(2026, 0, 5, 14, 2).toISOString(), now)).not.toMatch(/[A-Za-z]{3}\s/)
  })

  it('has a weekday prefix on another calendar day', () => {
    const now = new Date(2026, 0, 6, 9, 0)
    expect(formatClock(new Date(2026, 0, 5, 14, 2).toISOString(), now)).toMatch(/^[A-Za-z]{3}\s/)
  })
})

describe('formatHourMinute', () => {
  it.each([
    [new Date(2026, 0, 1, 9, 5), '9:05'],
    [new Date(2026, 0, 1, 14, 30), '14:30'],
    [new Date(2026, 0, 1, 0, 0), '0:00'],
  ])('%s reads %s', (date, expected) => {
    expect(formatHourMinute(date.toISOString())).toBe(expected)
  })
})

describe('formatShortClock', () => {
  it.each([new Date(2026, 0, 1, 9, 5), new Date(2026, 0, 1, 14, 30)])('%s is the locale clock with a padded hour and minute', (date) => {
    expect(formatShortClock(date.toISOString())).toBe(date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
  })
})

describe('formatMonthDay', () => {
  it.each([
    [new Date(2026, 10, 3, 12), 'Nov 3'],
    [new Date(2026, 0, 31, 12), 'Jan 31'],
  ])('%s reads %s', (date, expected) => {
    expect(formatMonthDay(date.toISOString())).toBe(expected)
  })
})

describe('formatTimeOfDay', () => {
  it('is the locale time, not the raw ISO', () => {
    const iso = new Date(2026, 0, 1, 9, 5, 7).toISOString()
    expect(formatTimeOfDay(iso)).toBe(new Date(iso).toLocaleTimeString())
  })
})

describe('exactTime', () => {
  it('is a locale string, not the raw ISO', () => {
    expect(exactTime('2026-01-01T12:00:00Z')).not.toBe('2026-01-01T12:00:00Z')
  })
})
