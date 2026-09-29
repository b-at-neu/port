import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDrainStore } from './store'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'port-dispatch-store-'))
}

describe('createDrainStore — current() before load()', () => {
  it('starts draining, reason unread — a not-yet-read file never reads as open', async () => {
    const dir = await makeTempDir()
    const store = createDrainStore(dir)
    expect(store.current()).toEqual({ gate: 'draining', reason: 'unread' })
  })
})

describe('createDrainStore — load()', () => {
  it('resolves open when the file is absent — first launch is a value, never an error', async () => {
    const dir = await makeTempDir()
    const store = createDrainStore(dir)
    await store.load()
    expect(store.current()).toEqual({ gate: 'open' })
  })

  it('resolves draining, reason operator, off a persisted since', async () => {
    const dir = await makeTempDir()
    const store = createDrainStore(dir)
    await store.set(true, '2026-01-01T00:00:00.000Z')
    const reloaded = createDrainStore(dir)
    await reloaded.load()
    expect(reloaded.current()).toEqual({ gate: 'draining', reason: 'operator', since: '2026-01-01T00:00:00.000Z' })
  })

  it('resolves open off a persisted resume', async () => {
    const dir = await makeTempDir()
    const store = createDrainStore(dir)
    await store.set(true, '2026-01-01T00:00:00.000Z')
    await store.set(false, '2026-01-01T00:01:00.000Z')
    const reloaded = createDrainStore(dir)
    await reloaded.load()
    expect(reloaded.current()).toEqual({ gate: 'open' })
  })

  it('reports unreadable for malformed JSON, and never overwrites it', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'dispatch.json'), '{not json')
    const store = createDrainStore(dir)
    await store.load()
    const current = store.current()
    expect(current.gate).toBe('draining')
    if (current.gate !== 'draining' || current.reason !== 'unreadable') throw new Error('expected unreadable')
    expect(current.message).toMatch(/./)
  })

  it('reports unreadable for an unsupported version, and never overwrites it', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'dispatch.json'), JSON.stringify({ version: 2, draining: true, since: null }))
    const store = createDrainStore(dir)
    await store.load()
    const current = store.current()
    if (current.gate !== 'draining' || current.reason !== 'unreadable') throw new Error('expected unreadable')
    expect(current.message).toMatch(/newer version/)
  })

  it('reports unreadable for a file that is not a dispatch file at all', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'dispatch.json'), JSON.stringify({ nonsense: true }))
    const store = createDrainStore(dir)
    await store.load()
    const current = store.current()
    if (current.gate !== 'draining' || current.reason !== 'unreadable') throw new Error('expected unreadable')
  })
})

describe('createDrainStore — set()', () => {
  it('round-trips drain then resume', async () => {
    const dir = await makeTempDir()
    const store = createDrainStore(dir)
    const drained = await store.set(true, '2026-01-01T00:00:00.000Z')
    expect(drained).toEqual({ ok: true })
    expect(store.current()).toEqual({ gate: 'draining', reason: 'operator', since: '2026-01-01T00:00:00.000Z' })

    const resumed = await store.set(false, '2026-01-01T00:01:00.000Z')
    expect(resumed).toEqual({ ok: true })
    expect(store.current()).toEqual({ gate: 'open' })
  })

  it('creates the directory on first write', async () => {
    const parent = await makeTempDir()
    const dir = join(parent, 'nested', 'userData')
    const store = createDrainStore(dir)
    const result = await store.set(true, '2026-01-01T00:00:00.000Z')
    expect(result.ok).toBe(true)
    const reloaded = createDrainStore(dir)
    await reloaded.load()
    expect(reloaded.current()).toEqual({ gate: 'draining', reason: 'operator', since: '2026-01-01T00:00:00.000Z' })
  })

  it('a failed set(true) still closes the gate in memory — the operator got the stop they asked for', async () => {
    const dir = await makeTempDir()
    // A file where the userData directory should be makes `ensureDirectory`
    // fail: `mkdir` on an existing non-directory path throws `ENOTDIR`.
    const blocked = join(dir, 'blocked-file')
    await writeFile(blocked, 'x')
    const nested = join(blocked, 'userData')
    const store = createDrainStore(nested)
    const result = await store.set(true, '2026-01-01T00:00:00.000Z')
    expect(result.ok).toBe(false)
    expect(store.current()).toEqual({ gate: 'draining', reason: 'operator', since: '2026-01-01T00:00:00.000Z' })
  })

  it('a failed set(false) changes nothing — a resume that did not persist must not disagree with the next launch', async () => {
    const dir = await makeTempDir()
    const store = createDrainStore(dir)
    await store.set(true, '2026-01-01T00:00:00.000Z')

    const blocked = join(dir, 'blocked-file')
    await writeFile(blocked, 'x')
    const nested = join(blocked, 'userData')
    const blockedStore = createDrainStore(nested)
    await blockedStore.set(true, '2026-01-01T00:00:00.000Z')
    const result = await blockedStore.set(false, '2026-01-01T00:01:00.000Z')
    expect(result.ok).toBe(false)
    expect(blockedStore.current()).toEqual({ gate: 'draining', reason: 'operator', since: '2026-01-01T00:00:00.000Z' })
  })
})
