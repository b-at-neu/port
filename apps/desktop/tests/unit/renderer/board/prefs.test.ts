import { describe, expect, it } from 'vitest'
import type { KeyValueStorage } from '@/types/storage'
import { readBoardView, setBoardView } from '@/renderer/board/prefs'

const KEY = 'port.boardView.v1'

function fakeStorage(initial?: string): KeyValueStorage {
  const store = new Map<string, string>()
  if (initial !== undefined) store.set(KEY, initial)
  return { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => void store.set(key, value) }
}

describe('board view prefs', () => {
  it('round-trips both views', () => {
    const storage = fakeStorage()
    setBoardView('board', storage)
    expect(readBoardView(storage)).toBe('board')
    setBoardView('list', storage)
    expect(readBoardView(storage)).toBe('list')
  })

  it('reads nothing saved as the list', () => {
    expect(readBoardView(fakeStorage())).toBe('list')
  })

  it.each(['{not json', 'nonsense', '"kanban"', '5', 'null', '["board"]'])('reads malformed value %s as the list', (raw) => {
    expect(readBoardView(fakeStorage(raw))).toBe('list')
  })

  it('reads a throwing getItem as the list', () => {
    const storage: KeyValueStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => undefined,
    }
    expect(readBoardView(storage)).toBe('list')
  })

  it('swallows a throwing setItem', () => {
    const storage: KeyValueStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      },
    }
    expect(() => setBoardView('board', storage)).not.toThrow()
  })
})
