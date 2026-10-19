import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { PromptHistoryStorage } from '@/types/session'
import { EMPTY_FILTER } from '@/renderer/backlog/filter'
import { backlogFilterFor, setBacklogFilter } from '@/renderer/backlog/prefs'

const A = 'repo-a' as RepoId
const B = 'repo-b' as RepoId
const KEY = 'port.backlogFilters.v1'

function fakeStorage(initial?: string): PromptHistoryStorage & { readonly store: Map<string, string> } {
  const store = new Map<string, string>()
  if (initial !== undefined) store.set(KEY, initial)
  return { store, getItem: (key) => store.get(key) ?? null, setItem: (key, value) => void store.set(key, value) }
}

describe('backlog filter prefs', () => {
  it('round-trips per repository', () => {
    const storage = fakeStorage()
    setBacklogFilter(A, { include: ['bug'], exclude: [] }, storage)
    setBacklogFilter(B, { include: [], exclude: ['epic'] }, storage)
    expect(backlogFilterFor(A, storage)).toEqual({ include: ['bug'], exclude: [] })
    expect(backlogFilterFor(B, storage)).toEqual({ include: [], exclude: ['epic'] })
  })

  it('reads an unknown repository as the empty filter', () => {
    expect(backlogFilterFor(A, fakeStorage())).toEqual(EMPTY_FILTER)
  })

  it.each(['{not json', 'null', '[]', '{"repo-a":{"include":"bug","exclude":[]}}', '{"repo-a":5}'])('reads malformed value %s as the empty filter', (raw) => {
    expect(backlogFilterFor(A, fakeStorage(raw))).toEqual(EMPTY_FILTER)
  })

  it('swallows a throwing setItem', () => {
    const storage: PromptHistoryStorage = {
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
