import { describe, expect, it } from 'vitest'
import { clearsOnPress, clearsOnSurfacePress, nextKey, prevKey, reconcile } from '@/renderer/shell/list-selection'

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

describe('clearsOnPress', () => {
  it('clears on a primary press of the selected row', () => {
    expect(clearsOnPress('b', 'b', 0, false)).toBe(true)
  })

  it('ignores a secondary or middle press on the selected row', () => {
    expect(clearsOnPress('b', 'b', 2, false)).toBe(false)
    expect(clearsOnPress('b', 'b', 1, false)).toBe(false)
  })

  it('selects as before when the row is not the selected one', () => {
    expect(clearsOnPress('a', 'b', 0, false)).toBe(false)
  })

  it('keeps the selection when the press lands on a control inside the row', () => {
    expect(clearsOnPress('b', 'b', 0, true)).toBe(false)
  })
})

describe('clearsOnSurfacePress', () => {
  it('clears on a primary press of blank space while a row is selected', () => {
    expect(clearsOnSurfacePress('blank', 0, 'a')).toBe(true)
  })

  it('keeps the selection for every other zone', () => {
    expect(clearsOnSurfacePress('row', 0, 'a')).toBe(false)
    expect(clearsOnSurfacePress('keep', 0, 'a')).toBe(false)
    expect(clearsOnSurfacePress('outside', 0, 'a')).toBe(false)
  })

  it('ignores a secondary or middle press', () => {
    expect(clearsOnSurfacePress('blank', 2, 'a')).toBe(false)
    expect(clearsOnSurfacePress('blank', 1, 'a')).toBe(false)
  })

  it('does nothing when no row is selected', () => {
    expect(clearsOnSurfacePress('blank', 0, null)).toBe(false)
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
