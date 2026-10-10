import { describe, expect, it, vi } from 'vitest'
import { createHostedStore } from './store'
import type { HostedStoreDeps } from './store'
import { createInMemoryHostingPersistence } from './persist'
import type { HostedQuery } from './handle'
import type { RepoId } from '../../shared/repos'
import type { SessionWorkspace } from '../../shared/workspace/types'

const REPO_ID = 'repo-1' as RepoId
const WORKSPACE: SessionWorkspace = { folder: '/repo', root: '/repo', worktree: { path: '/repo', branch: 'session/shared' }, base: null }

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
    readHistory: () => Promise.resolve({ kind: 'none' }),
    ...overrides,
  }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('createHostedStore rename()', () => {
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
