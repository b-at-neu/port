import { describe, expect, it } from 'vitest'
import { sessionDisplayLabel, startedClock } from './label'

describe('sessionDisplayLabel', () => {
  it('uses the title when set', () => {
    expect(sessionDisplayLabel({ title: 'Fix the thing', origin: { kind: 'fresh' } }, 'port')).toBe('port · Fix the thing')
  })

  it('falls back to "New session" for a fresh session with no title', () => {
    expect(sessionDisplayLabel({ title: null, origin: { kind: 'fresh' } }, 'port')).toBe('port · New session')
  })

  it('falls back to "Resumed session <first 8>" for a resumed session with no title', () => {
    expect(sessionDisplayLabel({ title: null, origin: { kind: 'resumed', from: 'abcdefgh1234' } }, 'port')).toBe('port · Resumed session abcdefgh')
  })

  it('falls back to "Fork of <first 8>" for a forked session with no title', () => {
    expect(sessionDisplayLabel({ title: null, origin: { kind: 'forked', from: 'abcdefgh1234', atMessageUuid: null } }, 'port')).toBe('port · Fork of abcdefgh')
  })
})

describe('startedClock', () => {
  it('renders just the time for the same calendar day', () => {
    const now = new Date(2026, 0, 5, 20, 0)
    const startedAt = new Date(2026, 0, 5, 14, 2).toISOString()
    expect(startedClock(startedAt, now)).not.toMatch(/[A-Za-z]{3}\s/)
  })

  it('renders a weekday prefix for a different calendar day', () => {
    const now = new Date(2026, 0, 6, 9, 0)
    const startedAt = new Date(2026, 0, 5, 14, 2).toISOString()
    expect(startedClock(startedAt, now)).toMatch(/^[A-Za-z]{3}\s/)
  })
})
