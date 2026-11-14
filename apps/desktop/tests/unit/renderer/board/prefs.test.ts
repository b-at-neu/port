import { describe, expect, it } from 'vitest'
import type { KeyValueStorage } from '@/types/storage'
import type { RepoId } from '@/utils/repos'
import { readBoardCollapsedLanes, readBoardView, setBoardLaneCollapsed, setBoardView } from '@/renderer/board/prefs'

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

describe('board collapsed lane prefs', () => {
  const LANES_KEY = 'port.boardCollapsedLanes.v1'
  const a = 'repo-a' as RepoId
  const b = 'repo-b' as RepoId

  function rawStorage(initial?: string): KeyValueStorage & { readonly store: Map<string, string> } {
    const store = new Map<string, string>()
    if (initial !== undefined) store.set(LANES_KEY, initial)
    return { store, getItem: (key) => store.get(key) ?? null, setItem: (key, value) => void store.set(key, value) }
  }

  it('round-trips two ids, then removes one', () => {
    const storage = rawStorage()
    setBoardLaneCollapsed(a, true, storage)
    setBoardLaneCollapsed(b, true, storage)
    expect([...readBoardCollapsedLanes(storage)].sort()).toEqual([a, b])
    setBoardLaneCollapsed(a, false, storage)
    expect([...readBoardCollapsedLanes(storage)]).toEqual([b])
  })

  it.each(['{not json', '{"a":1}', '"repo-a"', '[1]'])('reads malformed value %s as the empty set', (raw) => {
    expect(readBoardCollapsedLanes(rawStorage(raw)).size).toBe(0)
  })

  it('reads a throwing getItem as the empty set', () => {
    const storage: KeyValueStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => undefined,
    }
    expect(readBoardCollapsedLanes(storage).size).toBe(0)
  })

  it('swallows a throwing setItem', () => {
    const storage: KeyValueStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      },
    }
    expect(() => setBoardLaneCollapsed(a, true, storage)).not.toThrow()
  })

  it('uses a key distinct from the Backlog collapsed groups', () => {
    const storage = rawStorage()
    setBoardLaneCollapsed(a, true, storage)
    expect([...storage.store.keys()]).toEqual([LANES_KEY])
    expect(LANES_KEY).not.toBe('port.backlogCollapsed.v1')
  })
})
