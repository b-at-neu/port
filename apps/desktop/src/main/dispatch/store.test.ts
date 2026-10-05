import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../shared/repos'
import { makeTempDir } from '../../testing/fixtures'
import { createRunStateStore } from './store'

const REPO_A = 'repo-a' as RepoId
const REPO_B = 'repo-b' as RepoId

const registeredBoth = () => Promise.resolve([REPO_A, REPO_B] as readonly RepoId[])

describe('createRunStateStore — current() before load()', () => {
  it('reads paused, since null, for any repository — a not-yet-read file never reads as dispatching', async () => {
    const dir = await makeTempDir()
    const store = createRunStateStore(dir)
    expect(store.current(REPO_A)).toEqual({ repoId: REPO_A, state: 'paused', since: null })
  })
})

describe('createRunStateStore — load(), missing file', () => {
  it('resolves to no entries — every repository reads paused', async () => {
    const dir = await makeTempDir()
    const store = createRunStateStore(dir)
    await store.load(registeredBoth)
    expect(store.status()).toEqual({ kind: 'loaded' })
    expect(store.current(REPO_A)).toEqual({ repoId: REPO_A, state: 'paused', since: null })
  })
})

describe('createRunStateStore — load(), v1 migration', () => {
  it('v1 draining: false → every registered repository becomes dispatching, and the file is rewritten as v2', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'dispatch.json'), JSON.stringify({ version: 1, draining: false, since: null }))
    const store = createRunStateStore(dir)
    await store.load(registeredBoth)
    expect(store.current(REPO_A).state).toBe('dispatching')
    expect(store.current(REPO_B).state).toBe('dispatching')

    const reloaded = createRunStateStore(dir)
    await reloaded.load(() => Promise.reject(new Error('v2 must never call registered()')))
    expect(reloaded.current(REPO_A).state).toBe('dispatching')
  })

  it('v1 draining: true → every registered repository becomes paused, since the v1 since', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'dispatch.json'), JSON.stringify({ version: 1, draining: true, since: '2026-01-01T00:00:00.000Z' }))
    const store = createRunStateStore(dir)
    await store.load(registeredBoth)
    expect(store.current(REPO_A)).toEqual({ repoId: REPO_A, state: 'paused', since: '2026-01-01T00:00:00.000Z' })
  })

  it('v1 while the registry is unreadable — every repository paused, the v1 file untouched', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'dispatch.json'), JSON.stringify({ version: 1, draining: false, since: null }))
    const store = createRunStateStore(dir)
    await store.load(() => Promise.resolve(null))
    expect(store.current(REPO_A)).toEqual({ repoId: REPO_A, state: 'paused', since: null })

    const reloaded = createRunStateStore(dir)
    await reloaded.load(() => Promise.resolve(null))
    const text = await import('node:fs/promises').then((fs) => fs.readFile(join(dir, 'dispatch.json'), 'utf8'))
    expect(JSON.parse(text)).toEqual({ version: 1, draining: false, since: null })
  })
})

describe('createRunStateStore — load(), v2', () => {
  it('round-trips a v2 file written by set()', async () => {
    const dir = await makeTempDir()
    const store = createRunStateStore(dir)
    await store.load(registeredBoth)
    await store.set([REPO_A], 'draining', '2026-01-01T00:00:00.000Z')

    const reloaded = createRunStateStore(dir)
    await reloaded.load(registeredBoth)
    expect(reloaded.current(REPO_A)).toEqual({ repoId: REPO_A, state: 'draining', since: '2026-01-01T00:00:00.000Z' })
    expect(reloaded.current(REPO_B)).toEqual({ repoId: REPO_B, state: 'paused', since: null })
  })

  it('drops an entry with an unknown state individually — that repository reads paused', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'dispatch.json'), JSON.stringify({ version: 2, repositories: [{ id: REPO_A, state: 'bogus', since: null }] }))
    const store = createRunStateStore(dir)
    await store.load(registeredBoth)
    expect(store.status()).toEqual({ kind: 'loaded' })
    expect(store.current(REPO_A)).toEqual({ repoId: REPO_A, state: 'paused', since: null })
  })

  it('drops an entry with a non-string id individually', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'dispatch.json'), JSON.stringify({ version: 2, repositories: [{ id: 42, state: 'dispatching', since: null }] }))
    const store = createRunStateStore(dir)
    await store.load(registeredBoth)
    expect(store.status()).toEqual({ kind: 'loaded' })
  })

  it('reports unreadable for malformed JSON, and never overwrites it', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'dispatch.json'), '{not json')
    const store = createRunStateStore(dir)
    await store.load(registeredBoth)
    const status = store.status()
    expect(status.kind).toBe('unreadable')
  })

  it('reports unreadable for a version newer than this app supports, and never overwrites it', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'dispatch.json'), JSON.stringify({ version: 3, repositories: [] }))
    const store = createRunStateStore(dir)
    await store.load(registeredBoth)
    const status = store.status()
    if (status.kind !== 'unreadable') throw new Error('expected unreadable')
    expect(status.message).toMatch(/newer version/)
  })

  it('reports unreadable for a file that is not a dispatch file at all', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'dispatch.json'), JSON.stringify({ nonsense: true }))
    const store = createRunStateStore(dir)
    await store.load(registeredBoth)
    expect(store.status().kind).toBe('unreadable')
  })
})

describe('createRunStateStore — set()', () => {
  it('round-trips draining then dispatching for one repository, leaving others untouched', async () => {
    const dir = await makeTempDir()
    const store = createRunStateStore(dir)
    await store.load(registeredBoth)

    const drained = await store.set([REPO_A], 'draining', '2026-01-01T00:00:00.000Z')
    expect(drained).toEqual({ ok: true })
    expect(store.current(REPO_A)).toEqual({ repoId: REPO_A, state: 'draining', since: '2026-01-01T00:00:00.000Z' })
    expect(store.current(REPO_B)).toEqual({ repoId: REPO_B, state: 'paused', since: null })

    const run = await store.set([REPO_A], 'dispatching', '2026-01-01T00:01:00.000Z')
    expect(run).toEqual({ ok: true })
    expect(store.current(REPO_A)).toEqual({ repoId: REPO_A, state: 'dispatching', since: '2026-01-01T00:01:00.000Z' })
  })

  it('sets several repositories in one call (halt/pause scoping)', async () => {
    const dir = await makeTempDir()
    const store = createRunStateStore(dir)
    await store.load(registeredBoth)
    await store.set([REPO_A, REPO_B], 'paused', '2026-01-01T00:00:00.000Z')
    expect(store.current(REPO_A).state).toBe('paused')
    expect(store.current(REPO_B).state).toBe('paused')
  })

  it('creates the directory on first write', async () => {
    const parent = await makeTempDir()
    const dir = join(parent, 'nested', 'userData')
    const store = createRunStateStore(dir)
    const result = await store.set([REPO_A], 'paused', '2026-01-01T00:00:00.000Z')
    expect(result.ok).toBe(true)
    const reloaded = createRunStateStore(dir)
    await reloaded.load(registeredBoth)
    expect(reloaded.current(REPO_A).state).toBe('paused')
  })

  it('a failed set(..., "paused", ...) still applies in memory — the operator got the stop they asked for', async () => {
    const dir = await makeTempDir()
    const blocked = join(dir, 'blocked-file')
    await writeFile(blocked, 'x')
    const nested = join(blocked, 'userData')
    const store = createRunStateStore(nested)
    const result = await store.set([REPO_A], 'paused', '2026-01-01T00:00:00.000Z')
    if (result.ok) throw new Error('expected a failed write')
    expect(result.reason).toBe('unwritable')
    expect(typeof result.message).toBe('string')
    expect(store.current(REPO_A)).toEqual({ repoId: REPO_A, state: 'paused', since: '2026-01-01T00:00:00.000Z' })
  })

  it('a failed set(..., "dispatching", ...) changes nothing — a run that did not persist must not disagree with the next launch', async () => {
    const dir = await makeTempDir()
    const store = createRunStateStore(dir)
    await store.load(registeredBoth)
    await store.set([REPO_A], 'draining', '2026-01-01T00:00:00.000Z')

    const blocked = join(dir, 'blocked-file')
    await writeFile(blocked, 'x')
    const nested = join(blocked, 'userData')
    const blockedStore = createRunStateStore(nested)
    await blockedStore.set([REPO_A], 'draining', '2026-01-01T00:00:00.000Z')
    const result = await blockedStore.set([REPO_A], 'dispatching', '2026-01-01T00:01:00.000Z')
    expect(result.ok).toBe(false)
    expect(blockedStore.current(REPO_A)).toEqual({ repoId: REPO_A, state: 'draining', since: '2026-01-01T00:00:00.000Z' })
  })

  it('refuses dispatching and draining outright while the store is unreadable, but accepts paused as a no-op', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'dispatch.json'), '{not json')
    const store = createRunStateStore(dir)
    await store.load(registeredBoth)

    const pausedResult = await store.set([REPO_A], 'paused', '2026-01-01T00:00:00.000Z')
    expect(pausedResult).toEqual({ ok: true })

    const runResult = await store.set([REPO_A], 'dispatching', '2026-01-01T00:00:00.000Z')
    if (runResult.ok) throw new Error('expected a refused write')
    expect(runResult.reason).toBe('unreadable')
    expect(typeof runResult.message).toBe('string')

    const drainResult = await store.set([REPO_A], 'draining', '2026-01-01T00:00:00.000Z')
    if (drainResult.ok) throw new Error('expected a refused write')
    expect(drainResult.reason).toBe('unreadable')
    expect(typeof drainResult.message).toBe('string')
  })
})

describe('createRunStateStore — forget()', () => {
  it('removes a repository entry, after which it reads paused again', async () => {
    const dir = await makeTempDir()
    const store = createRunStateStore(dir)
    await store.load(registeredBoth)
    await store.set([REPO_A], 'dispatching', '2026-01-01T00:00:00.000Z')
    const result = await store.forget(REPO_A)
    expect(result).toEqual({ ok: true })
    expect(store.current(REPO_A)).toEqual({ repoId: REPO_A, state: 'paused', since: null })
  })

  it('is a no-op for a repository with no entry', async () => {
    const dir = await makeTempDir()
    const store = createRunStateStore(dir)
    await store.load(registeredBoth)
    expect(await store.forget(REPO_A)).toEqual({ ok: true })
  })
})

describe('createRunStateStore — snapshot()', () => {
  it('carries the store status and every requested repository\'s current state', async () => {
    const dir = await makeTempDir()
    const store = createRunStateStore(dir)
    await store.load(registeredBoth)
    await store.set([REPO_A], 'dispatching', '2026-01-01T00:00:00.000Z')
    expect(store.snapshot([REPO_A, REPO_B])).toEqual({
      store: { kind: 'loaded' },
      repositories: [
        { repoId: REPO_A, state: 'dispatching', since: '2026-01-01T00:00:00.000Z' },
        { repoId: REPO_B, state: 'paused', since: null },
      ],
    })
  })
})
