import { describe, expect, it } from 'vitest'
import { formatAgo, formatDuration, relativeTime } from '@/renderer/lib/relative-time'

describe('relativeTime', () => {
  it('reads under a minute as just now', () => {
    expect(relativeTime(5_000)).toBe('just now')
  })

  it('pluralizes minutes, hours and days', () => {
    expect(relativeTime(60_000)).toBe('1 minute ago')
    expect(relativeTime(120_000)).toBe('2 minutes ago')
    expect(relativeTime(60 * 60_000)).toBe('1 hour ago')
    expect(relativeTime(2 * 60 * 60_000)).toBe('2 hours ago')
    expect(relativeTime(24 * 60 * 60_000)).toBe('1 day ago')
    expect(relativeTime(3 * 24 * 60 * 60_000)).toBe('3 days ago')
  })
})

describe('formatAgo', () => {
  it('reads 59s as just now, 60s as 1m ago', () => {
    expect(formatAgo(59_000)).toBe('just now')
    expect(formatAgo(60_000)).toBe('1m ago')
  })

  it('reads 59m as minutes, 60m as hours', () => {
    expect(formatAgo(59 * 60_000)).toBe('59m ago')
    expect(formatAgo(60 * 60_000)).toBe('1h ago')
  })

  it('reads 24h as a day', () => {
    expect(formatAgo(23 * 60 * 60_000)).toBe('23h ago')
    expect(formatAgo(24 * 60 * 60_000)).toBe('1d ago')
  })
})

describe('formatDuration', () => {
  it('reads under a minute as <1m', () => {
    expect(formatDuration(30_000)).toBe('<1m')
  })

  it('reads minutes under an hour as plain minutes', () => {
    expect(formatDuration(12 * 60_000)).toBe('12m')
    expect(formatDuration(59 * 60_000)).toBe('59m')
  })

  it('reads an hour or more as hours and minutes', () => {
    expect(formatDuration(60 * 60_000)).toBe('1h 0m')
    expect(formatDuration(64 * 60_000)).toBe('1h 4m')
  })

  it('reads a day or more as days and hours', () => {
    expect(formatDuration(24 * 60 * 60_000)).toBe('1d 0h')
    expect(formatDuration((2 * 24 + 3) * 60 * 60_000)).toBe('2d 3h')
  })
})
