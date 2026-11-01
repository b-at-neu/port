import { describe, expect, it } from 'vitest'
import { createStageDenialStore } from '@/main/stage/denials'
import type { FileResult } from '@/types/platform'
import type { StageDenial } from '@/types/stage'
import type { RepoId } from '@/utils/repos'

const REPO = 'repo1' as RepoId

function denial(id: string, rule = `Bash(${id} *)`, repoId: RepoId = REPO): StageDenial {
  return { id, repoId, agent: 'impl', number: 480, toolName: 'Bash', inputSummary: id, rule, at: '2026-01-01T00:00:00.000Z', sessionKey: null }
}

function fakeDeps(initial: { readonly ok: true; readonly value: unknown } | { readonly ok: false }) {
  const writes: unknown[] = []
  function readJson<T>(): Promise<FileResult<T>> {
    return Promise.resolve(initial.ok ? { ok: true, value: initial.value as T } : { ok: false, kind: 'not-found', message: 'missing' })
  }
  function writeJsonAtomic(_path: string, value: unknown): Promise<FileResult<void>> {
    writes.push(value)
    return Promise.resolve({ ok: true, value: undefined })
  }
  return { readJson, writeJsonAtomic, writes }
}

function storeOver(initial: Parameters<typeof fakeDeps>[0]) {
  const deps = fakeDeps(initial)
  return { store: createStageDenialStore({ path: '/tmp/stage-denials.json', readJson: deps.readJson, writeJsonAtomic: deps.writeJsonAtomic }), writes: deps.writes }
}

describe('createStageDenialStore', () => {
  it('loads persisted denials per repository', async () => {
    const { store } = storeOver({ ok: true, value: { version: 1, entries: [denial('a'), denial('b', 'Bash(b *)', 'repo2' as RepoId)] } })
    await store.load()
    expect(store.list(REPO).map((d) => d.id)).toEqual(['a'])
    expect(store.list('repo2' as RepoId).map((d) => d.id)).toEqual(['b'])
  })

  it('loads as empty from a missing file, a malformed file or a bad entry', async () => {
    const missing = storeOver({ ok: false })
    await missing.store.load()
    expect(missing.store.list(REPO)).toEqual([])
    const malformed = storeOver({ ok: true, value: { version: 1 } })
    await malformed.store.load()
    expect(malformed.store.list(REPO)).toEqual([])
    const badEntry = storeOver({ ok: true, value: { version: 1, entries: [{ id: 'x' }, denial('ok')] } })
    await badEntry.store.load()
    expect(badEntry.store.list(REPO).map((d) => d.id)).toEqual(['ok'])
  })

  it('keeps a denial recorded before the load settles and persists the merge', async () => {
    const { store, writes } = storeOver({ ok: true, value: { version: 1, entries: [denial('a'), denial('b', 'Bash(x *)')] } })
    store.record(denial('c', 'Bash(x *)'))
    await store.load()
    expect(store.list(REPO).map((d) => d.id)).toEqual(['a', 'c'])
    expect(writes.at(-1)).toEqual({ version: 1, entries: [denial('a'), denial('c', 'Bash(x *)')] })
  })

  it('dedupes by rule and persists every change', () => {
    const { store, writes } = storeOver({ ok: false })
    store.record(denial('a', 'Bash(x *)'))
    store.record(denial('b', 'Bash(x *)'))
    expect(store.list(REPO).map((d) => d.id)).toEqual(['b'])
    expect(writes.at(-1)).toEqual({ version: 1, entries: [denial('b', 'Bash(x *)')] })
  })

  it('dismisses by id and clears by rule', () => {
    const { store } = storeOver({ ok: false })
    store.record(denial('a'))
    store.record(denial('b'))
    store.dismiss(REPO, 'a')
    expect(store.list(REPO).map((d) => d.id)).toEqual(['b'])
    store.clearRule(REPO, 'Bash(b *)')
    expect(store.list(REPO)).toEqual([])
  })

  it('keeps the in-memory state when a write fails', async () => {
    const store = createStageDenialStore({ path: '/p', readJson: () => Promise.resolve({ ok: false, kind: 'not-found', message: '' }), writeJsonAtomic: () => Promise.resolve({ ok: false, kind: 'io', message: 'disk full' }) })
    store.record(denial('a'))
    await Promise.resolve()
    expect(store.list(REPO)).toHaveLength(1)
  })
})
