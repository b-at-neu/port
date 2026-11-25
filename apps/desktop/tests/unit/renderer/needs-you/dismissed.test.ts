import { describe, expect, it, vi } from 'vitest'
import type { NeedsYouItem } from '@/types/board'
import { MAX_DISMISSED, createDismissedStore, dismissedItems, parseDismissed, visibleItems, withDismissed, withoutDismissed } from '@/renderer/needs-you/dismissed'
import { dismissKeyOf } from '@/renderer/needs-you/dismiss-key'

const AT = '2026-01-01T00:00:00.000Z'
const NOW = () => new Date(AT)

function memoryStorage(initial: string | null = null) {
  let value = initial
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => {
      value = next
    }),
  }
}

function denialItem(id: string): NeedsYouItem {
  return { kind: 'stage-denial', repoId: 'repo-a', repo: null, number: 554, title: null, url: null, ticket: null, at: null, matchedRow: null, denial: { id } } as unknown as NeedsYouItem
}

const entry = (key: string) => ({ key, at: AT })

describe('parseDismissed', () => {
  it.each([
    ['missing', null, []],
    ['not json', '{not json', []],
    ['a string', '"a string"', []],
    ['another version', JSON.stringify({ version: 2, entries: [entry('k')] }), []],
    ['entries not a list', JSON.stringify({ version: 1, entries: 'nope' }), []],
    ['mixed entries', JSON.stringify({ version: 1, entries: [entry('k1'), { key: 5, at: 't' }, null, entry('k2')] }), [entry('k1'), entry('k2')]],
  ])('%s reads as the entries that parse', (_name, raw, expected) => {
    expect(parseDismissed(raw)).toEqual(expected)
  })
})

describe('withDismissed', () => {
  const capped = Array.from({ length: MAX_DISMISSED }, (_, i) => entry(`k${String(i)}`))

  it.each([
    ['adds new keys', [entry('a')], ['b', 'c'], ['a', 'b', 'c']],
    ['dedupes a repeated key', [], ['a', 'a'], ['a']],
    ['skips a key already there', [entry('a')], ['a'], ['a']],
  ])('%s', (_name, entries, keys, expected) => {
    expect(withDismissed(entries, keys, AT).map((e) => e.key)).toEqual(expected)
  })

  it('drops the oldest past the cap', () => {
    const next = withDismissed(capped, ['new'], AT)
    expect(next).toHaveLength(MAX_DISMISSED)
    expect(next.map((e) => e.key)).not.toContain('k0')
    expect(next.at(-1)?.key).toBe('new')
  })

  it('returns the same array on a no-op', () => {
    const entries = [entry('a')]
    expect(withDismissed(entries, ['a'], AT)).toBe(entries)
  })
})

describe('withoutDismissed', () => {
  it.each([
    ['removes the given keys', ['a', 'c'], ['b']],
    ['ignores a key that is not there', ['nope'], ['a', 'b', 'c']],
  ])('%s', (_name, keys, expected) => {
    expect(withoutDismissed([entry('a'), entry('b'), entry('c')], keys).map((e) => e.key)).toEqual(expected)
  })

  it('returns the same array on a no-op', () => {
    const entries = [entry('a')]
    expect(withoutDismissed(entries, ['nope'])).toBe(entries)
  })
})

describe('createDismissedStore', () => {
  it('keeps a dismissal across a relaunch over the same storage, and Undo removes it', () => {
    const storage = memoryStorage()
    createDismissedStore(storage, NOW).dismiss(['a', 'b'])
    const relaunched = createDismissedStore(storage, NOW)
    expect([...relaunched.store.get().keys]).toEqual(['a', 'b'])
    relaunched.undismiss(['a'])
    expect([...createDismissedStore(storage, NOW).store.get().keys]).toEqual(['b'])
  })

  it('keeps the dismissal for this run when storage refuses the write', () => {
    const storage = memoryStorage()
    storage.setItem.mockImplementation(() => {
      throw new Error('quota')
    })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const dismissed = createDismissedStore(storage, NOW)
    dismissed.dismiss(['a'])
    expect(dismissed.store.get().keys.has('a')).toBe(true)
    errors.mockRestore()
  })
})

describe('visibleItems and dismissedItems', () => {
  const first = denialItem('d1')
  const second = denialItem('d2')

  it.each([
    ['nothing dismissed', new Set<string>(), [first, second], []],
    ['one dismissed', new Set([dismissKeyOf(first)]), [second], [first]],
    ['a stale key with no event', new Set(['gone']), [first, second], []],
  ])('%s: the two are complements', (_name, dismissed, visible, hidden) => {
    expect(visibleItems([first, second], dismissed)).toEqual(visible)
    expect(dismissedItems([first, second], dismissed)).toEqual(hidden)
  })
})
