import { describe, expect, it } from 'vitest'
import { createSessionMarks, MARKS_LIMIT } from './marks'

describe('createSessionMarks', () => {
  it('starts from the given initial state', () => {
    const tracker = createSessionMarks({ pinned: ['a'], archived: [] })
    expect(tracker.current()).toEqual({ pinned: ['a'], archived: [] })
  })

  it('adds and removes by kind', () => {
    const tracker = createSessionMarks({ pinned: [], archived: [] })
    tracker.set('pinned', 'a', true)
    expect(tracker.current().pinned).toEqual(['a'])
    tracker.set('pinned', 'a', false)
    expect(tracker.current().pinned).toEqual([])
  })

  it('is idempotent — setting an already-present id does not reorder it', () => {
    const tracker = createSessionMarks({ pinned: ['a', 'b'], archived: [] })
    tracker.set('pinned', 'a', true)
    expect(tracker.current().pinned).toEqual(['a', 'b'])
  })

  it('keeps insertion order for new entries', () => {
    const tracker = createSessionMarks({ pinned: [], archived: [] })
    tracker.set('pinned', 'a', true)
    tracker.set('pinned', 'b', true)
    expect(tracker.current().pinned).toEqual(['a', 'b'])
  })

  it('caps each kind at MARKS_LIMIT, dropping the oldest', () => {
    const initial = Array.from({ length: MARKS_LIMIT }, (_, i) => `id-${i}`)
    const tracker = createSessionMarks({ pinned: initial, archived: [] })
    tracker.set('pinned', 'new', true)
    const pinned = tracker.current().pinned
    expect(pinned.length).toBe(MARKS_LIMIT)
    expect(pinned[0]).toBe('id-1')
    expect(pinned[pinned.length - 1]).toBe('new')
  })

  it('keeps pinned and archived independent', () => {
    const tracker = createSessionMarks({ pinned: [], archived: [] })
    tracker.set('archived', 'a', true)
    expect(tracker.current()).toEqual({ pinned: [], archived: ['a'] })
  })
})
