import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createHostingPersistence, DEFAULT_SESSION_LIMIT } from './persist'
import type { RepoId } from '../../shared/repos'
import { DEFAULT_SESSION_DEFAULTS } from '../../shared/hosting/types'
import { makeTempDir } from '../../testing/fixtures'

const ENTRY = { repoId: 'repo-1' as RepoId, claudeSessionId: 'session-1', title: 'Title', startedAt: '2026-01-01T00:00:00.000Z' }
const EMPTY_MARKS = { pinned: [], archived: [] }

/** `save()` is fire-and-forget over real filesystem I/O, which needs a real macrotask turn to settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

describe('createHostingPersistence', () => {
  it('load() returns the default empty state when the file is absent', async () => {
    const dir = await makeTempDir()
    const persistence = createHostingPersistence({ dir })
    await expect(persistence.load()).resolves.toEqual({ limit: DEFAULT_SESSION_LIMIT, open: [], defaults: DEFAULT_SESSION_DEFAULTS, marks: EMPTY_MARKS })
  })

  it('load() returns the default empty state for garbage JSON', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'hosting.json'), '{not json')
    const persistence = createHostingPersistence({ dir })
    await expect(persistence.load()).resolves.toEqual({ limit: DEFAULT_SESSION_LIMIT, open: [], defaults: DEFAULT_SESSION_DEFAULTS, marks: EMPTY_MARKS })
  })

  it('load() returns the default empty state for a newer version', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'hosting.json'), JSON.stringify({ version: 2, limit: 4, open: [] }))
    const persistence = createHostingPersistence({ dir })
    await expect(persistence.load()).resolves.toEqual({ limit: DEFAULT_SESSION_LIMIT, open: [], defaults: DEFAULT_SESSION_DEFAULTS, marks: EMPTY_MARKS })
  })

  it('load() drops an out-of-range limit, falling back to the default', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'hosting.json'), JSON.stringify({ version: 1, limit: 99, open: [] }))
    const persistence = createHostingPersistence({ dir })
    await expect(persistence.load()).resolves.toEqual({ limit: DEFAULT_SESSION_LIMIT, open: [], defaults: DEFAULT_SESSION_DEFAULTS, marks: EMPTY_MARKS })
  })

  it('load() drops invalid open entries one by one', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'hosting.json'), JSON.stringify({ version: 1, limit: 4, open: [ENTRY, { repoId: '' }, 'nope'] }))
    const persistence = createHostingPersistence({ dir })
    await expect(persistence.load()).resolves.toEqual({ limit: 4, open: [ENTRY], defaults: DEFAULT_SESSION_DEFAULTS, marks: EMPTY_MARKS })
  })

  it('load() falls back to the default for an out-of-list model or permissionMode, each field on its own', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'hosting.json'), JSON.stringify({ version: 1, limit: 4, open: [], defaults: { model: 'nope', permissionMode: 'acceptEdits' } }))
    const persistence = createHostingPersistence({ dir })
    await expect(persistence.load()).resolves.toEqual({ limit: 4, open: [], defaults: { model: null, permissionMode: 'acceptEdits' }, marks: EMPTY_MARKS })
  })

  it('load() accepts a null model and an allowlisted permissionMode', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'hosting.json'), JSON.stringify({ version: 1, limit: 4, open: [], defaults: { model: 'opus', permissionMode: 'plan' } }))
    const persistence = createHostingPersistence({ dir })
    await expect(persistence.load()).resolves.toEqual({ limit: 4, open: [], defaults: { model: 'opus', permissionMode: 'plan' }, marks: EMPTY_MARKS })
  })

  it('load() accepts a v1 entry without cwd, loading with cwd undefined', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'hosting.json'), JSON.stringify({ version: 1, limit: 4, open: [ENTRY] }))
    const persistence = createHostingPersistence({ dir })
    const loaded = await persistence.load()
    expect(loaded.open).toEqual([ENTRY])
    expect(loaded.open[0]?.cwd).toBeUndefined()
  })

  it('load() accepts a null repoId paired with a cwd', async () => {
    const dir = await makeTempDir()
    const entry = { repoId: null, claudeSessionId: 'session-2', title: null, startedAt: '2026-01-01T00:00:00.000Z', cwd: '/home/you/src/widgets' }
    await writeFile(join(dir, 'hosting.json'), JSON.stringify({ version: 1, limit: 4, open: [entry] }))
    const persistence = createHostingPersistence({ dir })
    await expect(persistence.load()).resolves.toEqual({ limit: 4, open: [entry], defaults: DEFAULT_SESSION_DEFAULTS, marks: EMPTY_MARKS })
  })

  it('load() drops a null repoId with no cwd — it could never be restored', async () => {
    const dir = await makeTempDir()
    const entry = { repoId: null, claudeSessionId: 'session-2', title: null, startedAt: '2026-01-01T00:00:00.000Z' }
    await writeFile(join(dir, 'hosting.json'), JSON.stringify({ version: 1, limit: 4, open: [entry] }))
    const persistence = createHostingPersistence({ dir })
    await expect(persistence.load()).resolves.toEqual({ limit: 4, open: [], defaults: DEFAULT_SESSION_DEFAULTS, marks: EMPTY_MARKS })
  })

  it('load() falls back to the full default when defaults itself is missing or malformed', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'hosting.json'), JSON.stringify({ version: 1, limit: 4, open: [], defaults: 'nope' }))
    const persistence = createHostingPersistence({ dir })
    await expect(persistence.load()).resolves.toEqual({ limit: 4, open: [], defaults: DEFAULT_SESSION_DEFAULTS, marks: EMPTY_MARKS })
  })

  it('save() then load() round-trips the state', async () => {
    const dir = await makeTempDir()
    const persistence = createHostingPersistence({ dir })
    await persistence.load()
    persistence.save({ limit: 3, open: [ENTRY], defaults: { model: 'sonnet', permissionMode: 'acceptEdits' }, marks: EMPTY_MARKS })
    await flush()
    const reloaded = createHostingPersistence({ dir })
    await expect(reloaded.load()).resolves.toEqual({ limit: 3, open: [ENTRY], defaults: { model: 'sonnet', permissionMode: 'acceptEdits' }, marks: EMPTY_MARKS })
  })

  it('save() skips a write whose serialized JSON equals the last one written', async () => {
    const dir = await makeTempDir()
    const persistence = createHostingPersistence({ dir })
    await persistence.load()
    persistence.save({ limit: 4, open: [ENTRY], defaults: DEFAULT_SESSION_DEFAULTS, marks: EMPTY_MARKS })
    await flush()
    const before = await readFile(join(dir, 'hosting.json'), 'utf8')
    persistence.save({ limit: 4, open: [ENTRY], defaults: DEFAULT_SESSION_DEFAULTS, marks: EMPTY_MARKS })
    await flush()
    const after = await readFile(join(dir, 'hosting.json'), 'utf8')
    expect(after).toBe(before)
  })

  it('coalesces a save that lands while a write is already in flight to the newest state', async () => {
    const dir = await makeTempDir()
    const persistence = createHostingPersistence({ dir })
    await persistence.load()
    persistence.save({ limit: 4, open: [], defaults: DEFAULT_SESSION_DEFAULTS, marks: EMPTY_MARKS })
    persistence.save({ limit: 4, open: [ENTRY], defaults: DEFAULT_SESSION_DEFAULTS, marks: EMPTY_MARKS })
    persistence.save({ limit: 2, open: [], defaults: DEFAULT_SESSION_DEFAULTS, marks: EMPTY_MARKS })
    await flush()
    await flush()
    const reloaded = createHostingPersistence({ dir })
    await expect(reloaded.load()).resolves.toEqual({ limit: 2, open: [], defaults: DEFAULT_SESSION_DEFAULTS, marks: EMPTY_MARKS })
  })

  it('load() falls back to empty marks without dropping open/defaults, when marks is missing or malformed', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'hosting.json'), JSON.stringify({ version: 1, limit: 4, open: [ENTRY], defaults: DEFAULT_SESSION_DEFAULTS, marks: 'nope' }))
    const persistence = createHostingPersistence({ dir })
    await expect(persistence.load()).resolves.toEqual({ limit: 4, open: [ENTRY], defaults: DEFAULT_SESSION_DEFAULTS, marks: EMPTY_MARKS })
  })

  it('load() de-duplicates and drops over-long or non-string marks entries', async () => {
    const dir = await makeTempDir()
    const tooLong = 'x'.repeat(201)
    await writeFile(join(dir, 'hosting.json'), JSON.stringify({ version: 1, limit: 4, open: [], marks: { pinned: ['a', 'a', tooLong, 7], archived: [] } }))
    const persistence = createHostingPersistence({ dir })
    const state = await persistence.load()
    expect(state.marks).toEqual({ pinned: ['a'], archived: [] })
  })

  it('freeze() drops every later save', async () => {
    const dir = await makeTempDir()
    const persistence = createHostingPersistence({ dir })
    await persistence.load()
    persistence.save({ limit: 4, open: [], defaults: DEFAULT_SESSION_DEFAULTS, marks: EMPTY_MARKS })
    await flush()
    persistence.freeze()
    persistence.save({ limit: 4, open: [ENTRY], defaults: DEFAULT_SESSION_DEFAULTS, marks: EMPTY_MARKS })
    await flush()
    const reloaded = createHostingPersistence({ dir })
    await expect(reloaded.load()).resolves.toEqual({ limit: 4, open: [], defaults: DEFAULT_SESSION_DEFAULTS, marks: EMPTY_MARKS })
  })

  it('a failed write is logged and resolves rather than throwing', async () => {
    const dir = await makeTempDir()
    const persistence = createHostingPersistence({ dir })
    await persistence.load()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // Writing into a path that is itself a directory forces the atomic
    // rename to fail without touching real filesystem permissions.
    const badDir = join(dir, 'blocked')
    await import('node:fs/promises').then((fs) => fs.mkdir(join(badDir, 'hosting.json'), { recursive: true }))
    const blocked = createHostingPersistence({ dir: badDir })
    await blocked.load()
    expect(() => blocked.save({ limit: 4, open: [], defaults: DEFAULT_SESSION_DEFAULTS, marks: EMPTY_MARKS })).not.toThrow()
    await flush()
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
