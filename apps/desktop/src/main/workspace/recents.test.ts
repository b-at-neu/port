import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTempDir } from '../../testing/fixtures'
import { createRecentsStore, pruneMissing, RECENTS_CAP } from './recents'

describe('createRecentsStore', () => {
  it('load() returns an empty list when the file is absent', async () => {
    const dir = await makeTempDir()
    const store = createRecentsStore({ dir })
    await expect(store.load()).resolves.toEqual([])
  })

  it('load() returns an empty list for garbage JSON', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'folders.json'), '{not json')
    const store = createRecentsStore({ dir })
    await expect(store.load()).resolves.toEqual([])
  })

  it('load() returns an empty list for a newer version', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'folders.json'), JSON.stringify({ version: 2, recents: [{ path: '/a', lastUsedAt: '2026-01-01T00:00:00.000Z' }] }))
    const store = createRecentsStore({ dir })
    await expect(store.load()).resolves.toEqual([])
  })

  it('load() drops malformed entries one by one', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'folders.json'), JSON.stringify({ version: 1, recents: [{ path: '/a', lastUsedAt: '2026-01-01T00:00:00.000Z' }, { path: '' }, 'nope'] }))
    const store = createRecentsStore({ dir })
    await expect(store.load()).resolves.toEqual([{ path: '/a', lastUsedAt: '2026-01-01T00:00:00.000Z' }])
  })

  it('record() adds a new entry at the front', async () => {
    const dir = await makeTempDir()
    const store = createRecentsStore({ dir })
    await store.record('/repo', new Date('2026-01-01T00:00:00.000Z'))
    await expect(store.load()).resolves.toEqual([{ path: '/repo', lastUsedAt: '2026-01-01T00:00:00.000Z' }])
  })

  it('record() upserts by samePath rather than duplicating', async () => {
    const dir = await makeTempDir()
    const store = createRecentsStore({ dir })
    await store.record('/repo', new Date('2026-01-01T00:00:00.000Z'))
    await store.record('/repo', new Date('2026-01-02T00:00:00.000Z'))
    const entries = await store.load()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.lastUsedAt).toBe('2026-01-02T00:00:00.000Z')
  })

  it('record() moves an existing entry to the front on reuse', async () => {
    const dir = await makeTempDir()
    const store = createRecentsStore({ dir })
    await store.record('/a', new Date('2026-01-01T00:00:00.000Z'))
    await store.record('/b', new Date('2026-01-02T00:00:00.000Z'))
    await store.record('/a', new Date('2026-01-03T00:00:00.000Z'))
    const entries = await store.load()
    expect(entries.map((entry) => entry.path)).toEqual(['/a', '/b'])
  })

  it('record() caps the list at RECENTS_CAP, dropping the oldest', async () => {
    const dir = await makeTempDir()
    const store = createRecentsStore({ dir })
    for (let i = 0; i < RECENTS_CAP + 2; i += 1) {
      await store.record(`/repo-${i}`, new Date(2026, 0, i + 1))
    }
    const entries = await store.load()
    expect(entries).toHaveLength(RECENTS_CAP)
    expect(entries[0]?.path).toBe(`/repo-${RECENTS_CAP + 1}`)
    expect(entries.map((entry) => entry.path)).not.toContain('/repo-0')
  })
})

describe('pruneMissing', () => {
  it('drops an entry whose path no longer exists', async () => {
    const entries = [
      { path: '/here', lastUsedAt: '2026-01-01T00:00:00.000Z' },
      { path: '/gone', lastUsedAt: '2026-01-01T00:00:00.000Z' },
    ]
    const result = await pruneMissing(entries, (path) => Promise.resolve(path === '/here'))
    expect(result).toEqual([{ path: '/here', lastUsedAt: '2026-01-01T00:00:00.000Z' }])
  })
})
