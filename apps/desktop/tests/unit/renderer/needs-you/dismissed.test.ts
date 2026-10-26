import { describe, expect, it, vi } from 'vitest'
import type { NeedsYouItem } from '@/types/board'
import { MAX_DISMISSED, createDismissedStore, parseDismissed, visibleItems } from '@/renderer/needs-you/dismissed'
import { dismissKeyOf } from '@/renderer/needs-you/dismiss-key'

const NOW = () => new Date('2026-01-01T00:00:00.000Z')

function memoryStorage(initial: string | null = null) {
  let value = initial
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => {
      value = next
    }),
    read: () => value,
  }
}

function denialItem(id: string): NeedsYouItem {
  return { kind: 'stage-denial', repoId: 'repo-a', repo: null, number: 554, title: null, url: null, ticket: null, at: null, matchedRow: null, denial: { id } } as unknown as NeedsYouItem
}

describe('parseDismissed', () => {
  it('reads a missing, malformed or foreign value as empty', () => {
    expect(parseDismissed(null).entries).toEqual([])
    expect(parseDismissed('{not json').entries).toEqual([])
    expect(parseDismissed('"a string"').entries).toEqual([])
    expect(parseDismissed(JSON.stringify({ version: 2, entries: [{ key: 'k', at: 't' }] })).entries).toEqual([])
    expect(parseDismissed(JSON.stringify({ version: 1, entries: 'nope' })).entries).toEqual([])
  })

  it('keeps well-formed entries and drops the rest', () => {
    const raw = JSON.stringify({ version: 1, entries: [{ key: 'k1', at: 't' }, { key: 5, at: 't' }, null, { key: 'k2', at: 't' }] })
    expect(parseDismissed(raw).entries.map((e) => e.key)).toEqual(['k1', 'k2'])
  })
})

describe('createDismissedStore', () => {
  it('persists a dismissal, and a fresh store over the same storage still has it (a relaunch)', () => {
    const storage = memoryStorage()
    createDismissedStore(storage, NOW).dismiss(['a', 'b'])
    const relaunched = createDismissedStore(storage, NOW)
    expect([...relaunched.get()]).toEqual(['a', 'b'])
    expect(JSON.parse(storage.read() ?? '{}')).toMatchObject({ version: 1, entries: [{ key: 'a', at: '2026-01-01T00:00:00.000Z' }, { key: 'b' }] })
  })

  it('un-dismisses exactly the keys it is given', () => {
    const store = createDismissedStore(memoryStorage(), NOW)
    store.dismiss(['a', 'b', 'c'])
    store.undismiss(['b'])
    expect([...store.get()]).toEqual(['a', 'c'])
  })

  it('hands back the same set until something changes', () => {
    const store = createDismissedStore(memoryStorage(), NOW)
    store.dismiss(['a'])
    const before = store.get()
    store.dismiss(['a'])
    store.undismiss(['nope'])
    expect(store.get()).toBe(before)
    store.dismiss(['b'])
    expect(store.get()).not.toBe(before)
  })

  it('tells subscribers about a change and stops after unsubscribe', () => {
    const store = createDismissedStore(memoryStorage(), NOW)
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    store.dismiss(['a'])
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    store.dismiss(['b'])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('drops the oldest dismissals past the cap', () => {
    const store = createDismissedStore(memoryStorage(), NOW)
    store.dismiss(Array.from({ length: MAX_DISMISSED + 3 }, (_, i) => `k${String(i)}`))
    expect(store.get().size).toBe(MAX_DISMISSED)
    expect(store.get().has('k0')).toBe(false)
    expect(store.get().has('k2')).toBe(false)
    expect(store.get().has('k3')).toBe(true)
    expect(store.get().has(`k${String(MAX_DISMISSED + 2)}`)).toBe(true)
  })

  it('keeps the dismissal for this run when storage refuses the write', () => {
    const storage = memoryStorage()
    storage.setItem.mockImplementation(() => {
      throw new Error('quota')
    })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const store = createDismissedStore(storage, NOW)
    expect(() => store.dismiss(['a'])).not.toThrow()
    expect(store.get().has('a')).toBe(true)
    errors.mockRestore()
  })

  it('starts empty over a corrupt stored value', () => {
    expect(createDismissedStore(memoryStorage('{oops'), NOW).get().size).toBe(0)
  })
})

describe('visibleItems', () => {
  it('hides a dismissed event but still shows a new event on the same ticket', () => {
    const store = createDismissedStore(memoryStorage(), NOW)
    const first = denialItem('d1')
    const second = denialItem('d2')
    store.dismiss([dismissKeyOf(first)])
    expect(visibleItems([first, second], store.get())).toEqual([second])
  })

  it('shows an item again after Undo', () => {
    const store = createDismissedStore(memoryStorage(), NOW)
    const item = denialItem('d1')
    store.dismiss([dismissKeyOf(item)])
    store.undismiss([dismissKeyOf(item)])
    expect(visibleItems([item], store.get())).toEqual([item])
  })

  it('returns everything when nothing is dismissed', () => {
    const items = [denialItem('d1'), denialItem('d2')]
    expect(visibleItems(items, new Set())).toEqual(items)
  })
})
