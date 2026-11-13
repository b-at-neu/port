import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { KeyValueStorage } from '@/types/storage'
import { EMPTY_FILTER } from '@/renderer/backlog/filter'
import { readBacklogCollapsed, readBacklogFilters, readBacklogHiddenRepos, setBacklogCollapsed, setBacklogFilter, setBacklogHiddenRepos } from '@/renderer/backlog/prefs'

const A = 'repo-a' as RepoId
const B = 'repo-b' as RepoId
const KEY = 'port.backlogFilters.v1'

function fakeStorage(initial?: string): KeyValueStorage & { readonly store: Map<string, string> } {
  const store = new Map<string, string>()
  if (initial !== undefined) store.set(KEY, initial)
  return { store, getItem: (key) => store.get(key) ?? null, setItem: (key, value) => void store.set(key, value) }
}

describe('backlog filter prefs', () => {
  it('round-trips per repository', () => {
    const storage = fakeStorage()
    setBacklogFilter(A, { include: ['bug'], exclude: [] }, storage)
    setBacklogFilter(B, { include: [], exclude: ['epic'] }, storage)
    const filters = readBacklogFilters(storage)
    expect(filters.get(A)).toEqual({ include: ['bug'], exclude: [] })
    expect(filters.get(B)).toEqual({ include: [], exclude: ['epic'] })
  })

  it('reads an unknown repository as absent', () => {
    expect(readBacklogFilters(fakeStorage()).get(A)).toBeUndefined()
  })

  it('reads storage once per call, however many repositories it holds', () => {
    const storage = fakeStorage('{"repo-a":{"include":["bug"],"exclude":[]},"repo-b":{"include":[],"exclude":["epic"]}}')
    let reads = 0
    const counting: KeyValueStorage = {
      getItem: (key) => {
        reads += 1
        return storage.getItem(key)
      },
      setItem: (key, value) => storage.setItem(key, value),
    }
    expect(readBacklogFilters(counting).size).toBe(2)
    expect(reads).toBe(1)
  })

  it.each(['{not json', 'null', '[]', '{"repo-a":{"include":"bug","exclude":[]}}', '{"repo-a":5}'])('reads malformed value %s as no filter', (raw) => {
    expect(readBacklogFilters(fakeStorage(raw)).get(A)).toBeUndefined()
  })

  it('swallows a throwing setItem', () => {
    const storage: KeyValueStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      },
    }
    expect(() => setBacklogFilter(A, { include: ['bug'], exclude: [] }, storage)).not.toThrow()
  })

  it('removes the repository entry when the filter is emptied, leaving others', () => {
    const storage = fakeStorage()
    setBacklogFilter(A, { include: ['bug'], exclude: [] }, storage)
    setBacklogFilter(B, { include: ['docs'], exclude: [] }, storage)
    setBacklogFilter(A, EMPTY_FILTER, storage)
    expect(JSON.parse(storage.store.get(KEY) ?? '{}')).toEqual({ 'repo-b': { include: ['docs'], exclude: [] } })
  })
})

describe.each([
  { name: 'collapsed', key: 'port.backlogCollapsed.v1', read: readBacklogCollapsed },
  { name: 'hidden repositories', key: 'port.backlogHiddenRepos.v1', read: readBacklogHiddenRepos },
])('backlog $name prefs', ({ key, read }) => {
  it.each(['{not json', 'null', '{}', '[1]'])('reads malformed value %s as the empty set', (raw) => {
    const storage = fakeStorage()
    storage.store.set(key, raw)
    expect(read(storage).size).toBe(0)
  })

  it('reads an absent value as the empty set', () => {
    expect(read(fakeStorage()).size).toBe(0)
  })

  it('reads storage once per call', () => {
    let reads = 0
    const counting: KeyValueStorage = {
      getItem: () => {
        reads += 1
        return '["repo-a","repo-b"]'
      },
      setItem: () => undefined,
    }
    expect(read(counting).size).toBe(2)
    expect(reads).toBe(1)
  })
})

describe('backlog collapsed round-trip', () => {
  it('adds and removes a repository, leaving others', () => {
    const storage = fakeStorage()
    setBacklogCollapsed(A, true, storage)
    setBacklogCollapsed(B, true, storage)
    expect([...readBacklogCollapsed(storage)]).toEqual([A, B])
    setBacklogCollapsed(A, false, storage)
    expect([...readBacklogCollapsed(storage)]).toEqual([B])
  })

  it('does not touch the label filters', () => {
    const storage = fakeStorage()
    setBacklogFilter(A, { include: ['bug'], exclude: [] }, storage)
    setBacklogCollapsed(A, true, storage)
    expect(readBacklogFilters(storage).get(A)).toEqual({ include: ['bug'], exclude: [] })
  })

  it('swallows a throwing setItem', () => {
    const storage: KeyValueStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      },
    }
    expect(() => setBacklogCollapsed(A, true, storage)).not.toThrow()
    expect(() => setBacklogHiddenRepos(new Set([A]), storage)).not.toThrow()
  })
})

describe('backlog hidden repositories round-trip', () => {
  it('stores the hidden set and restores it', () => {
    const storage = fakeStorage()
    setBacklogHiddenRepos(new Set([A, B]), storage)
    expect([...readBacklogHiddenRepos(storage)]).toEqual([A, B])
    setBacklogHiddenRepos(new Set(), storage)
    expect(readBacklogHiddenRepos(storage).size).toBe(0)
  })
})
