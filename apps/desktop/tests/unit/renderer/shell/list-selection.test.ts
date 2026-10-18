import { describe, expect, it } from 'vitest'
import { nextKey, prevKey, reconcile } from '@/renderer/shell/list-selection'

const KEYS = ['a', 'b', 'c']

describe('nextKey', () => {
  it('selects the first key when nothing is selected', () => {
    expect(nextKey(KEYS, null)).toBe('a')
  })

  it('advances to the following key', () => {
    expect(nextKey(KEYS, 'a')).toBe('b')
  })

  it('clamps at the last key', () => {
    expect(nextKey(KEYS, 'c')).toBe('c')
  })

  it('falls back to the first key when the selected key is gone', () => {
    expect(nextKey(KEYS, 'missing')).toBe('a')
  })

  it('returns null for an empty list', () => {
    expect(nextKey([], null)).toBeNull()
  })
})

describe('prevKey', () => {
  it('selects the first key when nothing is selected', () => {
    expect(prevKey(KEYS, null)).toBe('a')
  })

  it('moves to the preceding key', () => {
    expect(prevKey(KEYS, 'c')).toBe('b')
  })

  it('clamps at the first key', () => {
    expect(prevKey(KEYS, 'a')).toBe('a')
  })

  it('falls back to the first key when the selected key is gone', () => {
    expect(prevKey(KEYS, 'missing')).toBe('a')
  })

  it('returns null for an empty list', () => {
    expect(prevKey([], null)).toBeNull()
  })
})

describe('reconcile', () => {
  it('keeps a selection still present', () => {
    expect(reconcile(KEYS, 'b')).toBe('b')
  })

  it('drops a selection no longer present', () => {
    expect(reconcile(KEYS, 'missing')).toBeNull()
  })

  it('stays null when nothing is selected', () => {
    expect(reconcile(KEYS, null)).toBeNull()
  })

  it('stays null against an empty list', () => {
    expect(reconcile([], 'a')).toBeNull()
  })
})
