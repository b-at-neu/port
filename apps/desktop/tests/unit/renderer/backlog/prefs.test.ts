import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { KeyValueStorage } from '@/types/storage'
import { EMPTY_FILTER } from '@/renderer/backlog/filter'
import { readBacklogCollapsed, readBacklogCollapsedEpics, readBacklogFilters, readBacklogHiddenRepos, setBacklogCollapsed, setBacklogCollapsedEpic, setBacklogFilter, setBacklogHiddenRepos } from '@/renderer/backlog/prefs'

const A = 'repo-a' as RepoId
const B = 'repo-b' as RepoId
const FILTERS_KEY = 'port.backlogFilters.v1'

function fakeStorage(initial: Readonly<Record<string, string>> = {}): KeyValueStorage & { readonly store: Map<string, string> } {
  const store = new Map(Object.entries(initial))
  return { store, getItem: (key) => store.get(key) ?? null, setItem: (key, value) => void store.set(key, value) }
}

const throwingStorage: KeyValueStorage = {
  getItem: () => null,
  setItem: () => {
    throw new Error('quota')
  },
}

describe('malformed storage reads as nothing', () => {
  it.each(['{not json', 'null', '[]', '{"repo-a":{"include":"bug","exclude":[]}}', '{"repo-a":5}'])('filters from %s', (raw) => {
    expect(readBacklogFilters(fakeStorage({ [FILTERS_KEY]: raw })).get(A)).toBeUndefined()
  })

  it.each([
    ['collapsed', 'port.backlogCollapsed.v1', readBacklogCollapsed],
    ['hidden repositories', 'port.backlogHiddenRepos.v1', readBacklogHiddenRepos],
    ['collapsed epics', 'port.backlogCollapsedEpics.v1', readBacklogCollapsedEpics],
  ])('the %s set', (_name, key, read) => {
    for (const raw of ['{not json', 'null', '{}', '[1]']) expect(read(fakeStorage({ [key]: raw })).size).toBe(0)
    expect(read(fakeStorage()).size).toBe(0)
  })
})

describe('round trips', () => {
  it('keeps filters per repository and removes an emptied one, leaving others', () => {
    const storage = fakeStorage()
    setBacklogFilter(A, { include: ['bug'], exclude: [] }, storage)
    setBacklogFilter(B, { include: [], exclude: ['epic'] }, storage)
    expect(readBacklogFilters(storage).get(B)).toEqual({ include: [], exclude: ['epic'] })
    setBacklogFilter(A, EMPTY_FILTER, storage)
    expect([...readBacklogFilters(storage).keys()]).toEqual([B])
  })

  it('adds and removes collapsed repositories, epics and hidden repositories independently', () => {
    const storage = fakeStorage()
    setBacklogCollapsed(A, true, storage)
    setBacklogCollapsed(B, true, storage)
    setBacklogCollapsed(A, false, storage)
    setBacklogCollapsedEpic('repo-a:41', true, storage)
    setBacklogHiddenRepos(new Set([A]), storage)
    expect([...readBacklogCollapsed(storage)]).toEqual([B])
    expect([...readBacklogCollapsedEpics(storage)]).toEqual(['repo-a:41'])
    expect([...readBacklogHiddenRepos(storage)]).toEqual([A])
  })

  it('swallows a throwing setItem in every writer', () => {
    expect(() => {
      setBacklogFilter(A, { include: ['bug'], exclude: [] }, throwingStorage)
      setBacklogCollapsed(A, true, throwingStorage)
      setBacklogCollapsedEpic('repo-a:41', true, throwingStorage)
      setBacklogHiddenRepos(new Set([A]), throwingStorage)
    }).not.toThrow()
  })
})
