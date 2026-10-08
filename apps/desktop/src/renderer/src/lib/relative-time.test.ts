import { describe, expect, it } from 'vitest'
import { relativeTime } from './relative-time'

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
