import { describe, expect, it } from 'vitest'
import { sessionKeyOf } from '@/renderer/app/session-key'

describe('sessionKeyOf', () => {
  it.each([
    ['/session', { key: 'abc' }, 'abc'],
    ['/session', { key: null }, null],
    ['/session', {}, null],
    ['/session', { key: '' }, null],
    ['/board', { key: 'abc' }, null],
  ])('%s with %j is %j', (pathname, search, expected) => {
    expect(sessionKeyOf({ pathname, search })).toBe(expected)
  })
})
