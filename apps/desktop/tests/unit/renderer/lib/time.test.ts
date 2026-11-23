import { describe, expect, it } from 'vitest'
import { exactTime, formatAgo, formatAgoSince, formatClock, formatDuration, relativeTime } from '@/renderer/lib/time'

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

describe('exactTime', () => {
  it('is a locale string, not the raw ISO', () => {
    expect(exactTime('2026-01-01T12:00:00Z')).not.toBe('2026-01-01T12:00:00Z')
  })
})
