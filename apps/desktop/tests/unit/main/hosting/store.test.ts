import { describe, expect, it, vi } from 'vitest'
import { createHostedStore } from '@/main/sessions/hosting/store'
import { ENDED_RETAIN_LIMIT } from '@/main/sessions/hosting/handles'
import { createInMemoryHostingPersistence, DEFAULT_SESSION_LIMIT } from '@/main/sessions/hosting/persist'
import type { HostedQuery } from '@/main/sessions/hosting/handle'
import { pathOps } from '@/main/platform/paths'
import { DEFAULT_SESSION_DEFAULTS } from '@/types/hosting'
import { DEFAULT_NOTIFICATION_PREFS } from '@/types/settings'
import type { SessionWorkspace } from '@/types/workspace'
import { fakeWhich } from '../../../support/fake-platform'
import { REPO_ID, endedQuery, flush, hostingCtx, idleQuery, sdkWith, storeOptions } from '../../../fixtures/hosting/store'

// Worktree-shaped so repeated starts against it never trip folder-busy, exercised separately below.
const WORKSPACE: SessionWorkspace = { folder: '/repo', root: '/repo', worktree: { path: '/repo', branch: 'session/shared' }, base: null }

const START = { repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKSPACE } as const

const SESSION_ID = '3f2a9c10-1b2c-4d3e-8f4a-5b6c7d8e9f01'

const BUNDLED ='/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude'

const STAGE = { tag: { agent: 'impl', number: 550, kind: 'issue', trigger: 'planApproved' }, agent: { name: 'impl-agent', definition: { description: 'impl', prompt: 'body' } }, instructionsRoot: '/bundle', model: 'sonnet', sessionRequiredPaths: [] } as const

describe('createHostedStore', () => {
  it('start() returns a ready snapshot naming the repo, and a second start() mints a distinct sessionKey', async () => {
    const store = createHostedStore(hostingCtx(), storeOptions())
    const a = await store.start(START)
    const b = await store.start(START)
    if (!a.ok || !b.ok) throw new Error('unreachable')
    expect(a.snapshot).toMatchObject({ repoId: REPO_ID, sessionKey: 'hosted-1' })
    expect(b.snapshot.sessionKey).not.toBe(a.snapshot.sessionKey)
    expect(store.list()).toHaveLength(2)
  })

  it('refuses at-capacity once DEFAULT_SESSION_LIMIT live handles exist', async () => {
    const store = createHostedStore(hostingCtx(), storeOptions())
    for (let i = 0; i < DEFAULT_SESSION_LIMIT; i += 1) {
      expect((await store.start(START)).ok).toBe(true)
    }
    expect(await store.start(START)).toEqual({ ok: false, kind: 'at-capacity', limit: DEFAULT_SESSION_LIMIT })
  })

  it.each([
    { name: 'the executable cannot be located', path: null, expected: { ok: false, kind: 'runtime', diagnosis: 'cli-missing', detail: null } },
    { name: 'the executable is the SDK bundled binary', path: BUNDLED, expected: { ok: false, kind: 'runtime', diagnosis: 'bundled-fallback', detail: BUNDLED } },
  ])('returns the runtime branch, never starting a handle, when $name', async ({ path, expected }) => {
    const which = fakeWhich(() => Promise.resolve(path === null ? { ok: false, kind: 'not-found', command: 'claude', searched: ['/usr/bin'] } : { ok: true, path }))
    const store = createHostedStore(hostingCtx({ which }), storeOptions())
    expect(await store.start(START)).toEqual(expected)
    expect(store.list()).toEqual([])
  })

  it('reports unknown-session for every operation on a key that was never started', async () => {
    const store = createHostedStore(hostingCtx(), storeOptions())
    const key = 'hosted-999' as import('@/types/hosting').SessionKey
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

  it('an operator start passes no plugins option, so a session loads only the installed plugins', async () => {
    let capturedOptions: { plugins?: unknown; settings?: unknown } | undefined
    const ctx = hostingCtx({
      sdk: sdkWith((queryParams) => {
        capturedOptions = queryParams.options
        return idleQuery()
      }),
    })
    await ctx.fs.writeJsonAtomic(pathOps.join(ctx.claudeHome, 'settings.json'), { enabledPlugins: { 'user@only': true } })
    await createHostedStore(ctx, storeOptions()).start(START)
    expect(capturedOptions?.plugins).toBeUndefined()
    expect(capturedOptions?.settings).toBeUndefined()
  })

  it("a stage start turns off the operator's own plugins that its worktree does not enable", async () => {
    let capturedOptions: { settings?: unknown } | undefined
    const ctx = hostingCtx({
      sdk: sdkWith((queryParams) => {
        capturedOptions = queryParams.options
        return idleQuery()
      }),
    })
    await ctx.fs.writeJsonAtomic(pathOps.join(ctx.claudeHome, 'settings.json'), { enabledPlugins: { 'user@only': true, 'shared@both': true } })
    await ctx.fs.writeJsonAtomic('/repo/.claude/settings.json', { enabledPlugins: { 'shared@both': true }, permissions: { allow: ['Edit(src/**)'] } })
    const started = await createHostedStore(ctx, storeOptions()).start({ ...START, stage: STAGE })
    expect(started.ok).toBe(true)
    expect(capturedOptions?.settings).toEqual({ enabledPlugins: { 'user@only': false } })
  })

  it('send() on a live session queues, and attach() reflects the message in the entries window', async () => {
    const store = createHostedStore(hostingCtx(), storeOptions())
    const started = await store.start(START)
    if (!started.ok) throw new Error('unreachable')
    const key = started.snapshot.sessionKey

    expect(store.answerPermission(key, 'nonexistent', 'deny', null)).toEqual({ ok: false, kind: 'unknown-permission' })
    expect(store.attach(key)).toEqual({ ok: true, snapshot: started.snapshot, replay: [], droppedBefore: 0, entries: [], firstIndex: 0, partial: null, pendingSends: [], revision: 0, history: { kind: 'none' } })

    const sent = store.send(key, 'hello')
    expect(sent).toMatchObject({ ok: true, queued: true })
    const attached = store.attach(key)
    if (!attached.ok) throw new Error('unreachable')
    expect(attached.entries).toHaveLength(1)
    expect(attached.entries[0]).toMatchObject({ type: 'user-text' })
    expect(attached.pendingSends).toHaveLength(1)
    expect(attached.revision).toBe(1)
  })

  it(
    'closeAll() closes every live handle',
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
      const store = createHostedStore(hostingCtx({ sdk: sdkWith(query) }), storeOptions())
      await store.start(START)
      await store.start(START)
      await store.closeAll()
      expect(closeSpy).toHaveBeenCalledTimes(2)
    },
    10_000,
  )

  it('a fork start titles the fork from its parent once init reports the new id', async () => {
    const renameSession = vi.fn(() => Promise.resolve())
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
      hostingCtx({ sdk: sdkWith(query, renameSession) }),
      storeOptions({
        listSessions: () =>
          Promise.resolve({ ok: true, sessions: [{ sessionId: 'parent-1', summary: 'Parent title', lastModified: 'x', customTitle: null, firstPrompt: null, gitBranch: null, cwd: null }] }),
      }),
    )
    const started = await store.start({ repoId: REPO_ID, mode: { kind: 'fork', sessionId: 'parent-1' }, workspace: WORKSPACE })
    if (!started.ok) throw new Error('unreachable')

    box.deliver?.({ type: 'system', subtype: 'init', session_id: 'fork-session-1' })
    await flush()

    expect(renameSession).toHaveBeenCalledWith('fork-session-1', 'Parent title (fork)', { dir: '/repo' })
  })

  describe('already-open', () => {
    it('refuses a resume whose sessionId a handle is already resuming (before init)', async () => {
      const store = createHostedStore(hostingCtx(), storeOptions())
      const first = await store.start({ repoId: REPO_ID, mode: { kind: 'resume', sessionId: 'parent-1' }, workspace: WORKSPACE })
      if (!first.ok) throw new Error('unreachable')
      const second = await store.start({ repoId: REPO_ID, mode: { kind: 'resume', sessionId: 'parent-1' }, workspace: WORKSPACE })
      expect(second).toEqual({ ok: false, kind: 'already-open', sessionKey: first.snapshot.sessionKey })
    })

    it('refuses a resume whose sessionId a live handle has adopted via init', async () => {
      const box: { deliver: ((message: unknown) => void) | null } = { deliver: null }
      const query = (): HostedQuery =>
        ({
          interrupt: vi.fn(),
          close: vi.fn(),
          [Symbol.asyncIterator]() {
            return { next: () => new Promise<IteratorResult<unknown>>((resolve) => (box.deliver = (message) => resolve({ done: false, value: message }))) }
          },
        }) as unknown as HostedQuery
      const store = createHostedStore(hostingCtx({ sdk: sdkWith(query) }), storeOptions())
      const first = await store.start(START)
      if (!first.ok) throw new Error('unreachable')
      box.deliver?.({ type: 'system', subtype: 'init', session_id: 'adopted-1' })
      await flush()
      const second = await store.start({ repoId: REPO_ID, mode: { kind: 'resume', sessionId: 'adopted-1' }, workspace: WORKSPACE })
      expect(second).toEqual({ ok: false, kind: 'already-open', sessionKey: first.snapshot.sessionKey })
    })

    it('allows a fork of an open session id, since a fork gets a new id', async () => {
      const store = createHostedStore(hostingCtx(), storeOptions())
      const first = await store.start({ repoId: REPO_ID, mode: { kind: 'resume', sessionId: 'parent-1' }, workspace: WORKSPACE })
      if (!first.ok) throw new Error('unreachable')
      const forked = await store.start({ repoId: REPO_ID, mode: { kind: 'fork', sessionId: 'parent-1' }, workspace: WORKSPACE })
      expect(forked.ok).toBe(true)
    })
  })

  it.each([
    { name: 'a resume start loads the transcript', mode: { kind: 'resume', sessionId: SESSION_ID } as const, seed: true, expected: { kind: 'loaded', omittedBefore: 0, sourceSessionId: SESSION_ID } },
    { name: 'a fork start surfaces a failed history read rather than throwing', mode: { kind: 'fork', sessionId: SESSION_ID } as const, seed: false, expected: { kind: 'failed' } },
  ])('$name', async ({ mode, seed, expected }) => {
    const ctx = hostingCtx()
    if (seed) {
      await ctx.fs.writeText(pathOps.join(ctx.claudeHome, 'projects', 'p1', `${SESSION_ID}.jsonl`), `${JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } })}\n`)
    }
    const store = createHostedStore(ctx, storeOptions())
    const result = await store.start({ repoId: REPO_ID, mode, workspace: WORKSPACE })
    if (!result.ok) throw new Error('unreachable')
    const attached = store.attach(result.snapshot.sessionKey)
    if (!attached.ok) throw new Error('unreachable')
    expect(attached.history).toMatchObject(expected)
  })

  it('setLimit lowers the limit without closing any session, only refusing a new start', async () => {
    const store = createHostedStore(hostingCtx(), storeOptions())
    await store.start(START)
    await store.start(START)
    await store.start(START)
    await store.setLimit(1)
    expect(store.list().filter((snapshot) => snapshot.phase !== 'ended')).toHaveLength(3)
    expect(await store.start(START)).toEqual({ ok: false, kind: 'at-capacity', limit: 1 })
  })

  it('capacity() reports the loaded limit and the fixed ceiling', async () => {
    const store = createHostedStore(hostingCtx(), storeOptions())
    await expect(store.capacity()).resolves.toEqual({ limit: DEFAULT_SESSION_LIMIT, ceiling: 8 })
    await store.setLimit(6)
    await expect(store.capacity()).resolves.toEqual({ limit: 6, ceiling: 8 })
  })

  it('dismiss refuses still-open and removes an ended handle', async () => {
    const openStore = createHostedStore(hostingCtx(), storeOptions())
    const openStarted = await openStore.start(START)
    if (!openStarted.ok) throw new Error('unreachable')
    await expect(openStore.dismiss(openStarted.snapshot.sessionKey, 'keep')).resolves.toEqual({ ok: false, kind: 'still-open' })

    const store = createHostedStore(hostingCtx({ sdk: sdkWith(endedQuery) }), storeOptions())
    const started = await store.start(START)
    if (!started.ok) throw new Error('unreachable')
    await flush()
    expect(store.list().find((snapshot) => snapshot.sessionKey === started.snapshot.sessionKey)?.phase).toBe('ended')
    await expect(store.dismiss(started.snapshot.sessionKey, 'keep')).resolves.toEqual({ ok: true })
    expect(store.list()).toEqual([])
  })

  it('retains at most ENDED_RETAIN_LIMIT ended handles, evicting the oldest first', async () => {
    const store = createHostedStore(hostingCtx({ sdk: sdkWith(endedQuery) }), storeOptions())
    const keys: string[] = []
    for (let i = 0; i < ENDED_RETAIN_LIMIT + 3; i += 1) {
      const started = await store.start(START)
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
    persistence.save({ limit: 1, open: [{ repoId: REPO_ID, claudeSessionId: 'parent-1', title: 'Old title', startedAt: 't0' }], defaults: DEFAULT_SESSION_DEFAULTS, marks: { pinned: [], archived: [] }, notifications: DEFAULT_NOTIFICATION_PREFS })
    const store = createHostedStore(hostingCtx(), storeOptions({ persistence }))
    await store.start(START)

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
      notifications: DEFAULT_NOTIFICATION_PREFS,
    })
    const store = createHostedStore(hostingCtx(), storeOptions({ persistence }))
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
      const store = createHostedStore(hostingCtx({ sdk: sdkWith(query) }), storeOptions({ persistence }))
      const started = await store.start(START)
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

  it('defaults and notification prefs persist without touching an open session or each other', async () => {
    const persistence = createInMemoryHostingPersistence()
    const store = createHostedStore(hostingCtx(), storeOptions({ persistence }))
    await expect(store.defaults()).resolves.toEqual(DEFAULT_SESSION_DEFAULTS)
    await expect(store.notificationPrefs()).resolves.toEqual(DEFAULT_NOTIFICATION_PREFS)
    const started = await store.start(START)
    if (!started.ok) throw new Error('unreachable')

    const next = { model: 'opus' as const, permissionMode: 'acceptEdits' as const }
    await expect(store.setDefaults(next)).resolves.toEqual(next)
    await expect(store.setNotificationPrefs({ needsYou: false, sessions: true })).resolves.toEqual({ needsYou: false, sessions: true })
    await expect(store.defaults()).resolves.toEqual(next)
    await expect(persistence.load()).resolves.toMatchObject({ notifications: { needsYou: false, sessions: true }, defaults: next })
    expect(store.attach(started.snapshot.sessionKey)).toMatchObject({ ok: true })
  })
})
