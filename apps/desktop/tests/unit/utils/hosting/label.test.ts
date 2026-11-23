import { describe, expect, it } from 'vitest'
import { sessionDisplayLabel } from '@/utils/hosting/label'

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
