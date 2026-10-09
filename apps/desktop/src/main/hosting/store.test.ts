import { describe, expect, it, vi } from 'vitest'
import { createHostedStore, DEFAULT_SESSION_LIMIT, ENDED_RETAIN_LIMIT } from './store'
import type { HostedStoreDeps } from './store'
import { createInMemoryHostingPersistence } from './persist'
import type { HostedQuery } from './handle'
import type { RepoId } from '../../shared/repos'
import { DEFAULT_SESSION_DEFAULTS } from '../../shared/hosting/types'
import type { SessionWorkspace } from '../../shared/workspace/types'

const REPO_ID = 'repo-1' as RepoId
// Worktree-shaped so repeated starts against it never trip folder-busy, exercised separately below.
const WORKSPACE: SessionWorkspace = { folder: '/repo', root: '/repo', worktree: { path: '/repo', branch: 'session/shared' }, base: null }

/** A never-emitting fake query — enough for tests that only care about store-level bookkeeping. */
function idleQuery(): HostedQuery {
  return {
    interrupt: vi.fn(() => Promise.resolve({ still_queued: [] })),
    close: vi.fn(),
    [Symbol.asyncIterator]() {
      return { next: () => new Promise<IteratorResult<unknown>>(() => undefined) }
    },
  } as unknown as HostedQuery
}

function baseDeps(overrides: Partial<HostedStoreDeps> = {}): HostedStoreDeps {
  return {
    getSdk: () => Promise.resolve({ query: () => idleQuery(), renameSession: vi.fn(() => Promise.resolve(undefined)) }),
    resolveClaudeExecutable: () => Promise.resolve({ ok: true, path: '/usr/local/bin/claude' }),
    readCredentialsTell: () => Promise.resolve({ present: false, expiresAt: null, hasRefreshToken: false }),
    listSessionsForFork: () => Promise.resolve({ ok: true, sessions: [] }),
    env: {},
    platform: 'linux',
    now: () => 1_000,
    onEvent: vi.fn(),
    onStatus: vi.fn(),
    onEntries: vi.fn(),
    resolvePluginRequest: () => Promise.resolve({ source: 'installed' }),
    readExpectedComponents: () => Promise.resolve(null),
    samePath: (a: string, b: string) => a === b,
    persistence: createInMemoryHostingPersistence(),
    removeWorktree: () => Promise.resolve({ outcome: 'removed' }),
    ...overrides,
  }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('createHostedStore', () => {
  it('start() returns a ready snapshot naming the repo', async () => {
    const store = createHostedStore(baseDeps())
    const result = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.snapshot.repoId).toBe(REPO_ID)
    expect(result.snapshot.sessionKey).toBe('hosted-1')
  })

  it('a second start() mints a distinct sessionKey', async () => {
    const store = createHostedStore(baseDeps())
    const a = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
    const b = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
    if (!a.ok || !b.ok) throw new Error('unreachable')
    expect(a.snapshot.sessionKey).not.toBe(b.snapshot.sessionKey)
  })

  it('refuses at-capacity once DEFAULT_SESSION_LIMIT live handles exist', async () => {
    const store = createHostedStore(baseDeps())
    for (let i = 0; i < DEFAULT_SESSION_LIMIT; i += 1) {
      const result = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
      expect(result.ok).toBe(true)
    }
    const refused = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
    expect(refused).toEqual({ ok: false, kind: 'at-capacity', limit: DEFAULT_SESSION_LIMIT })
  })

  it('returns the runtime branch, never starting a handle, when the executable cannot be located', async () => {
    const onEvent = vi.fn()
    const store = createHostedStore(baseDeps({ resolveClaudeExecutable: () => Promise.resolve({ ok: false, kind: 'not-found', searched: ['/usr/bin'] }), onEvent }))
    const result = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
    expect(result).toEqual({ ok: false, kind: 'runtime', diagnosis: 'cli-missing', detail: null })
    expect(store.list()).toEqual([])
  })

  it('reports bundled-fallback with the path as detail', async () => {
    const store = createHostedStore(baseDeps({ resolveClaudeExecutable: () => Promise.resolve({ ok: false, kind: 'bundled-fallback', path: '/bundled/claude' }) }))
    const result = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
    expect(result).toEqual({ ok: false, kind: 'runtime', diagnosis: 'bundled-fallback', detail: '/bundled/claude' })
  })

  it('send/interrupt/close/attach/answerPermission/invoke all report unknown-session for a key that was never started', async () => {
    const store = createHostedStore(baseDeps())
    const key = 'hosted-999' as import('../../shared/hosting/types').SessionKey
    expect(store.send(key, 'hi')).toEqual({ ok: false, kind: 'unknown-session' })
    await expect(store.interrupt(key)).resolves.toEqual({ ok: false, kind: 'unknown-session' })
    await expect(store.close(key)).resolves.toEqual({ ok: false, kind: 'unknown-session' })
    expect(store.attach(key)).toEqual({ ok: false, kind: 'unknown-session' })
    expect(store.answerPermission(key, 'perm-1', 'deny', null)).toEqual({ ok: false, kind: 'unknown-session' })
    expect(store.invoke(key, 'pipeline', '')).toEqual({ ok: false, kind: 'unknown-session' })
    await expect(store.setControls(key, { permissionMode: 'acceptEdits' })).resolves.toEqual({ ok: false, kind: 'unknown-session' })
    expect(store.answerQuestion(key, 'perm-1', {})).toEqual({ ok: false, kind: 'unknown-session' })
    expect(store.answerPlan(key, 'perm-1', { kind: 'keep-planning', feedback: 'x' })).toEqual({ ok: false, kind: 'unknown-session' })
  })

  it('start() resolves the plugin request for the installed source and passes no plugins to buildSessionOptions', async () => {
    const resolvePluginRequest = vi.fn(() => Promise.resolve({ source: 'installed' as const }))
    let capturedOptions: { plugins?: unknown } | undefined
    const query = (queryParams: { options?: { plugins?: unknown } }): HostedQuery => {
      capturedOptions = queryParams.options
      return idleQuery()
    }
    const store = createHostedStore(baseDeps({ resolvePluginRequest, getSdk: () => Promise.resolve({ query, renameSession: vi.fn(() => Promise.resolve(undefined)) }) }))
    await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
    expect(resolvePluginRequest).toHaveBeenCalledWith('/repo')
    expect(capturedOptions?.plugins).toBeUndefined()
  })

  it('start() resolves the plugin request for the repository source and passes it to buildSessionOptions', async () => {
    const resolvePluginRequest = vi.fn(() => Promise.resolve({ source: 'repository' as const, path: '/repo/plugins/port' }))
    let capturedOptions: { plugins?: unknown } | undefined
    const query = (queryParams: { options?: { plugins?: unknown } }): HostedQuery => {
      capturedOptions = queryParams.options
      return idleQuery()
    }
    const store = createHostedStore(baseDeps({ resolvePluginRequest, getSdk: () => Promise.resolve({ query, renameSession: vi.fn(() => Promise.resolve(undefined)) }) }))
    await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
    expect(capturedOptions?.plugins).toEqual([{ type: 'local', path: '/repo/plugins/port' }])
  })

  it('answerPermission on a live session delegates to that handle, refusing an unknown permission id', async () => {
    const store = createHostedStore(baseDeps())
    const started = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
    if (!started.ok) throw new Error('unreachable')
    const result = store.answerPermission(started.snapshot.sessionKey, 'nonexistent', 'deny', null)
    expect(result).toEqual({ ok: false, kind: 'unknown-permission' })
  })

  it('send() on a live session delegates to the handle and returns queued: true', async () => {
    const store = createHostedStore(baseDeps())
    const started = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
    if (!started.ok) throw new Error('unreachable')
    const result = store.send(started.snapshot.sessionKey, 'hello')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.queued).toBe(true)
  })

  it('attach() returns the snapshot plus an empty replay and entries window for a freshly started session', async () => {
    const store = createHostedStore(baseDeps())
    const started = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
    if (!started.ok) throw new Error('unreachable')
    const result = store.attach(started.snapshot.sessionKey)
    expect(result).toEqual({
      ok: true,
      snapshot: started.snapshot,
      replay: [],
      droppedBefore: 0,
      entries: [],
      firstIndex: 0,
      partial: null,
      pendingSends: [],
      revision: 0,
      history: { kind: 'none' },
    })
  })

  it('attach() reflects a sent message in the entries window', async () => {
    const store = createHostedStore(baseDeps())
    const started = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
    if (!started.ok) throw new Error('unreachable')
    store.send(started.snapshot.sessionKey, 'hello')
    const result = store.attach(started.snapshot.sessionKey)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({ type: 'user-text' })
    expect(result.pendingSends).toHaveLength(1)
    expect(result.revision).toBe(1)
  })

  it('list() reports every started session', async () => {
    const store = createHostedStore(baseDeps())
    await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
    await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
    expect(store.list().length).toBe(2)
  })

  it(
    'closeAll() calls close() on every live handle',
    async () => {
      const closeSpy = vi.fn()
      // This fake never reacts to the input ending, so close() waits out CLOSE_GRACE_MS; each query() gets its own `finish`.
      function query(): HostedQuery {
        let finish: (() => void) | null = null
        return {
          interrupt: vi.fn(),
          close: () => {
            closeSpy()
            finish?.()
          },
          [Symbol.asyncIterator]() {
            return { next: () => new Promise<IteratorResult<unknown>>((resolve) => (finish = () => resolve({ done: true, value: undefined }))) }
          },
        } as unknown as HostedQuery
      }
      const store = createHostedStore(baseDeps({ getSdk: () => Promise.resolve({ query, renameSession: vi.fn(() => Promise.resolve(undefined)) }) }))
      await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
      await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
      await store.closeAll()
      expect(closeSpy).toHaveBeenCalledTimes(2)
    },
    10_000,
  )

  it('a fork start wires titleFork through onSessionId once init reports the new id', async () => {
    const renameSession = vi.fn(() => Promise.resolve(undefined))
    const box: { deliver: ((message: unknown) => void) | null } = { deliver: null }
    const query = (): HostedQuery =>
      ({
        interrupt: vi.fn(),
        close: vi.fn(),
        [Symbol.asyncIterator]() {
          return {
            next: () =>
              new Promise<IteratorResult<unknown>>((resolve) => {
                box.deliver = (message) => resolve({ done: false, value: message })
              }),
          }
        },
      }) as unknown as HostedQuery

    const store = createHostedStore(
      baseDeps({
        getSdk: () => Promise.resolve({ query, renameSession }),
        listSessionsForFork: () =>
          Promise.resolve({ ok: true, sessions: [{ sessionId: 'parent-1', summary: 'Parent title', lastModified: 'x', customTitle: null, firstPrompt: null, gitBranch: null, cwd: null }] }),
      }),
    )
    const started = await store.start({ repoId: REPO_ID, mode: { kind: 'fork', sessionId: 'parent-1' }, workspace: WORKSPACE })
    if (!started.ok) throw new Error('unreachable')

    box.deliver?.({ type: 'system', subtype: 'init', session_id: 'fork-session-1' })
    // One flush for the pump's await, more for titleFork's async chain before setTitled().
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(renameSession).toHaveBeenCalledWith('fork-session-1', 'Parent title (fork)', { dir: '/repo' })
  })

  it('refuses already-open for a resume whose sessionId a handle is already resuming (before init)', async () => {
    const store = createHostedStore(baseDeps())
    const first = await store.start({ repoId: REPO_ID, mode: { kind: 'resume', sessionId: 'parent-1' }, workspace: WORKSPACE })
    if (!first.ok) throw new Error('unreachable')
    const second = await store.start({ repoId: REPO_ID, mode: { kind: 'resume', sessionId: 'parent-1' }, workspace: WORKSPACE })
    expect(second).toEqual({ ok: false, kind: 'already-open', sessionKey: first.snapshot.sessionKey })
  })

  it('refuses already-open for a resume whose sessionId a live handle has adopted via init', async () => {
    const box: { deliver: ((message: unknown) => void) | null } = { deliver: null }
    const query = (): HostedQuery =>
      ({
        interrupt: vi.fn(),
        close: vi.fn(),
        [Symbol.asyncIterator]() {
          return { next: () => new Promise<IteratorResult<unknown>>((resolve) => (box.deliver = (message) => resolve({ done: false, value: message }))) }
        },
      }) as unknown as HostedQuery
    const store = createHostedStore(baseDeps({ getSdk: () => Promise.resolve({ query, renameSession: vi.fn(() => Promise.resolve(undefined)) }) }))
    const first = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
    if (!first.ok) throw new Error('unreachable')
    box.deliver?.({ type: 'system', subtype: 'init', session_id: 'adopted-1' })
    await flush()
    const second = await store.start({ repoId: REPO_ID, mode: { kind: 'resume', sessionId: 'adopted-1' }, workspace: WORKSPACE })
    expect(second).toEqual({ ok: false, kind: 'already-open', sessionKey: first.snapshot.sessionKey })
  })

  it('allows a fork of an open session id, since a fork gets a new id', async () => {
    const store = createHostedStore(baseDeps())
    const first = await store.start({ repoId: REPO_ID, mode: { kind: 'resume', sessionId: 'parent-1' }, workspace: WORKSPACE })
    if (!first.ok) throw new Error('unreachable')
    const forked = await store.start({ repoId: REPO_ID, mode: { kind: 'fork', sessionId: 'parent-1' }, workspace: WORKSPACE })
    expect(forked.ok).toBe(true)
  })

  it('setLimit lowers the limit without closing any session, only refusing a new start', async () => {
    const store = createHostedStore(baseDeps())
    await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
    await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
    await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
    await store.setLimit(1)
    expect(store.list().filter((snapshot) => snapshot.phase !== 'ended')).toHaveLength(3)
    const refused = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
    expect(refused).toEqual({ ok: false, kind: 'at-capacity', limit: 1 })
  })

  it('capacity() reports the loaded limit and the fixed ceiling', async () => {
    const store = createHostedStore(baseDeps())
    await expect(store.capacity()).resolves.toEqual({ limit: DEFAULT_SESSION_LIMIT, ceiling: 8 })
    await store.setLimit(6)
    await expect(store.capacity()).resolves.toEqual({ limit: 6, ceiling: 8 })
  })

  function endedQuery(): HostedQuery {
    return {
      interrupt: vi.fn(),
      close: vi.fn(),
      [Symbol.asyncIterator]() {
        return { next: () => Promise.resolve({ done: true, value: undefined }) }
      },
    } as unknown as HostedQuery
  }

  it('dismiss refuses still-open and removes an ended handle', async () => {
    const openStore = createHostedStore(baseDeps())
    const openStarted = await openStore.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
    if (!openStarted.ok) throw new Error('unreachable')
    await expect(openStore.dismiss(openStarted.snapshot.sessionKey, 'keep')).resolves.toEqual({ ok: false, kind: 'still-open' })

    const store = createHostedStore(baseDeps({ getSdk: () => Promise.resolve({ query: endedQuery, renameSession: vi.fn(() => Promise.resolve(undefined)) }) }))
    const started = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
    if (!started.ok) throw new Error('unreachable')
    await flush()
    expect(store.list().find((snapshot) => snapshot.sessionKey === started.snapshot.sessionKey)?.phase).toBe('ended')
    await expect(store.dismiss(started.snapshot.sessionKey, 'keep')).resolves.toEqual({ ok: true })
    expect(store.list()).toEqual([])
  })

  it('retains at most ENDED_RETAIN_LIMIT ended handles, evicting the oldest first', async () => {
    const store = createHostedStore(baseDeps({ getSdk: () => Promise.resolve({ query: endedQuery, renameSession: vi.fn(() => Promise.resolve(undefined)) }) }))
    const keys: string[] = []
    for (let i = 0; i < ENDED_RETAIN_LIMIT + 3; i += 1) {
      const started = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
      if (!started.ok) throw new Error('unreachable')
      keys.push(started.snapshot.sessionKey)
      await flush()
    }
    const remaining = store.list().map((snapshot) => snapshot.sessionKey)
    expect(remaining).toHaveLength(ENDED_RETAIN_LIMIT)
    expect(remaining).not.toContain(keys[0])
    expect(remaining).toContain(keys[keys.length - 1])
  })

  it('restore() removes the entry on a successful start, but keeps it when at-capacity', async () => {
    const persistence = createInMemoryHostingPersistence()
    persistence.save({ limit: 1, open: [{ repoId: REPO_ID, claudeSessionId: 'parent-1', title: 'Old title', startedAt: 't0' }], defaults: DEFAULT_SESSION_DEFAULTS, marks: { pinned: [], archived: [] } })
    const store = createHostedStore(baseDeps({ persistence }))
    await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })

    const entries = await store.restorable()
    expect(entries).toHaveLength(1)
    const restoreId = entries[0]?.restoreId as string

    const refused = await store.restore(restoreId, { repoId: REPO_ID, workspace: WORKSPACE })
    expect(refused).toEqual({ ok: false, kind: 'at-capacity', limit: 1 })
    expect(await store.restorable()).toHaveLength(1)

    await store.setLimit(2)
    const succeeded = await store.restore(restoreId, { repoId: REPO_ID, workspace: WORKSPACE })
    expect(succeeded.ok).toBe(true)
    expect(await store.restorable()).toHaveLength(0)
  })

  it('discardRestorable() removes one entry, or every entry with null', async () => {
    const persistence = createInMemoryHostingPersistence()
    persistence.save({
      limit: 4,
      open: [
        { repoId: REPO_ID, claudeSessionId: 'a', title: null, startedAt: 't1' },
        { repoId: REPO_ID, claudeSessionId: 'b', title: null, startedAt: 't2' },
      ],
      defaults: DEFAULT_SESSION_DEFAULTS,
      marks: { pinned: [], archived: [] },
    })
    const store = createHostedStore(baseDeps({ persistence }))
    const entries = await store.restorable()
    await store.discardRestorable(entries[0]?.restoreId as string)
    expect(await store.restorable()).toHaveLength(1)
    await store.discardRestorable(null)
    expect(await store.restorable()).toHaveLength(0)
  })

  it(
    "after closeAll() the last save still lists the open sessions -- freeze() runs before any handle's closing phase is persisted",
    async () => {
      const box: { deliver: ((message: unknown) => void) | null; finish: (() => void) | null } = { deliver: null, finish: null }
      function query(): HostedQuery {
        return {
          interrupt: vi.fn(),
          close: () => box.finish?.(),
          [Symbol.asyncIterator]() {
            return {
              next: () =>
                new Promise<IteratorResult<unknown>>((resolve) => {
                  box.finish = () => resolve({ done: true, value: undefined })
                  box.deliver = (message) => resolve({ done: false, value: message })
                }),
            }
          },
        } as unknown as HostedQuery
      }
      const persistence = createInMemoryHostingPersistence()
      const store = createHostedStore(baseDeps({ getSdk: () => Promise.resolve({ query, renameSession: vi.fn(() => Promise.resolve(undefined)) }), persistence }))
      const started = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
      if (!started.ok) throw new Error('unreachable')
      box.deliver?.({ type: 'system', subtype: 'init', session_id: 'adopted-1' })
      await flush()
      await store.closeAll()
      const saved = await persistence.load()
      expect(saved.open).toHaveLength(1)
      expect(saved.open[0]).toMatchObject({ repoId: REPO_ID, claudeSessionId: 'adopted-1', title: null })
      expect(typeof saved.open[0]?.startedAt).toBe('string')
    },
    10_000,
  )

  it('defaults()/setDefaults() persist and never touch an open session', async () => {
    const store = createHostedStore(baseDeps())
    await expect(store.defaults()).resolves.toEqual(DEFAULT_SESSION_DEFAULTS)
    const started = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
    if (!started.ok) throw new Error('unreachable')
    const next = { model: 'opus' as const, permissionMode: 'acceptEdits' as const }
    await expect(store.setDefaults(next)).resolves.toEqual(next)
    await expect(store.defaults()).resolves.toEqual(next)
    expect(store.attach(started.snapshot.sessionKey)).toMatchObject({ ok: true })
  })

  it('rename() reports unknown-session and not-ready before renaming on disk', async () => {
    const store = createHostedStore(baseDeps())
    const key = 'hosted-999' as import('../../shared/hosting/types').SessionKey
    await expect(store.rename(key, 'New title')).resolves.toEqual({ ok: false, kind: 'unknown-session' })
    const started = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
    if (!started.ok) throw new Error('unreachable')
    await expect(store.rename(started.snapshot.sessionKey, 'New title')).resolves.toEqual({ ok: false, kind: 'not-ready' })
  })

  it('rename() renames on disk then applies the title to the handle', async () => {
    const renameSession = vi.fn(() => Promise.resolve(undefined))
    const box: { deliver: ((message: unknown) => void) | null } = { deliver: null }
    const query = (): HostedQuery =>
      ({
        interrupt: vi.fn(),
        close: vi.fn(),
        [Symbol.asyncIterator]() {
          return { next: () => new Promise<IteratorResult<unknown>>((resolve) => (box.deliver = (message) => resolve({ done: false, value: message }))) }
        },
      }) as unknown as HostedQuery
    const store = createHostedStore(baseDeps({ getSdk: () => Promise.resolve({ query, renameSession }) }))
    const started = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
    if (!started.ok) throw new Error('unreachable')
    box.deliver?.({ type: 'system', subtype: 'init', session_id: 'claude-1' })
    await flush()
    const result = await store.rename(started.snapshot.sessionKey, 'New title')
    expect(result).toEqual({ ok: true })
    expect(renameSession).toHaveBeenCalledWith('claude-1', 'New title', { dir: '/repo' })
    expect(store.attach(started.snapshot.sessionKey)).toMatchObject({ snapshot: { title: 'New title' } })
  })

  it('rename() reports rename-failed and leaves the title unchanged on a rejection', async () => {
    const renameSession = vi.fn(() => Promise.reject(new Error('disk full')))
    const box: { deliver: ((message: unknown) => void) | null } = { deliver: null }
    const query = (): HostedQuery =>
      ({
        interrupt: vi.fn(),
        close: vi.fn(),
        [Symbol.asyncIterator]() {
          return { next: () => new Promise<IteratorResult<unknown>>((resolve) => (box.deliver = (message) => resolve({ done: false, value: message }))) }
        },
      }) as unknown as HostedQuery
    const store = createHostedStore(baseDeps({ getSdk: () => Promise.resolve({ query, renameSession }) }))
    const started = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE })
    if (!started.ok) throw new Error('unreachable')
    box.deliver?.({ type: 'system', subtype: 'init', session_id: 'claude-1' })
    await flush()
    const result = await store.rename(started.snapshot.sessionKey, 'New title')
    expect(result).toEqual({ ok: false, kind: 'rename-failed', message: 'disk full' })
    expect(store.attach(started.snapshot.sessionKey)).toMatchObject({ snapshot: { title: null } })
  })
})
