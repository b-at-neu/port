// folder-busy and the worktree dismiss outcomes — split out of store.test.ts to stay under the file size limit.
import { describe, expect, it, vi } from 'vitest'
import { createHostedStore } from './store'
import type { HostedStoreDeps } from './store'
import { createInMemoryHostingPersistence } from './persist'
import type { HostedQuery } from './handle'
import type { RepoId } from '../../shared/repos'
import type { SessionWorkspace } from '../../shared/workspace/types'

const REPO_ID = 'repo-1' as RepoId
const PLAIN_WORKSPACE: SessionWorkspace = { folder: '/repo', root: '/repo', worktree: null, base: null }
const WORKTREE_WORKSPACE: SessionWorkspace = { folder: '/repo/.claude/worktrees/session-a', root: '/repo', worktree: { path: '/repo/.claude/worktrees/session-a', branch: 'session/a' }, base: null }

function idleQuery(): HostedQuery {
  return {
    interrupt: vi.fn(() => Promise.resolve({ still_queued: [] })),
    close: vi.fn(),
    [Symbol.asyncIterator]() {
      return { next: () => new Promise<IteratorResult<unknown>>(() => undefined) }
    },
  } as unknown as HostedQuery
}

function endedQuery(): HostedQuery {
  return {
    interrupt: vi.fn(),
    close: vi.fn(),
    [Symbol.asyncIterator]() {
      return { next: () => Promise.resolve({ done: true, value: undefined }) }
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

describe('createHostedStore — folder-busy', () => {
  it('refuses a second non-worktree start in the same folder', async () => {
    const store = createHostedStore(baseDeps())
    const first = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: PLAIN_WORKSPACE })
    if (!first.ok) throw new Error('unreachable')
    const second = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: PLAIN_WORKSPACE })
    expect(second).toEqual({ ok: false, kind: 'folder-busy', sessionKey: first.snapshot.sessionKey })
  })

  it('already-open wins over folder-busy for a resume of a session already open in that folder', async () => {
    const store = createHostedStore(baseDeps())
    const first = await store.start({ repoId: REPO_ID, mode: { kind: 'resume', sessionId: 'parent-1' }, workspace: PLAIN_WORKSPACE })
    if (!first.ok) throw new Error('unreachable')
    const second = await store.start({ repoId: REPO_ID, mode: { kind: 'resume', sessionId: 'parent-1' }, workspace: PLAIN_WORKSPACE })
    expect(second).toEqual({ ok: false, kind: 'already-open', sessionKey: first.snapshot.sessionKey })
  })

  it('allows a non-worktree start in a different folder, and once the first has ended', async () => {
    const store = createHostedStore(baseDeps({ getSdk: () => Promise.resolve({ query: endedQuery, renameSession: vi.fn(() => Promise.resolve(undefined)) }) }))
    const first = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: PLAIN_WORKSPACE })
    if (!first.ok) throw new Error('unreachable')
    await flush()
    const second = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: PLAIN_WORKSPACE })
    expect(second.ok).toBe(true)

    const otherStore = createHostedStore(baseDeps())
    const otherFolder: SessionWorkspace = { folder: '/other', root: '/other', worktree: null, base: null }
    const busy = await otherStore.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: PLAIN_WORKSPACE })
    expect(busy.ok).toBe(true)
    const elsewhere = await otherStore.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: otherFolder })
    expect(elsewhere.ok).toBe(true)
  })

  it('allows a worktree session to start alongside a live non-worktree one in the same root', async () => {
    const store = createHostedStore(baseDeps())
    const plain = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: PLAIN_WORKSPACE })
    expect(plain.ok).toBe(true)
    const worktreeStart = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKTREE_WORKSPACE })
    expect(worktreeStart.ok).toBe(true)
  })
})

describe('createHostedStore — dismiss worktree outcomes', () => {
  it('remove calls removeWorktree, forgetting the handle on removed', async () => {
    const removeWorktree = vi.fn(() => Promise.resolve({ outcome: 'removed' as const }))
    const store = createHostedStore(baseDeps({ getSdk: () => Promise.resolve({ query: endedQuery, renameSession: vi.fn(() => Promise.resolve(undefined)) }), removeWorktree }))
    const started = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKTREE_WORKSPACE })
    if (!started.ok) throw new Error('unreachable')
    await flush()
    const result = await store.dismiss(started.snapshot.sessionKey, 'remove')
    expect(removeWorktree).toHaveBeenCalledWith('/repo/.claude/worktrees/session-a', false)
    expect(result).toEqual({ ok: true })
    expect(store.list()).toEqual([])
  })

  it('remove reports worktree-dirty and keeps the handle when the worktree is dirty', async () => {
    const removeWorktree = vi.fn(() => Promise.resolve({ outcome: 'dirty' as const }))
    const store = createHostedStore(baseDeps({ getSdk: () => Promise.resolve({ query: endedQuery, renameSession: vi.fn(() => Promise.resolve(undefined)) }), removeWorktree }))
    const started = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKTREE_WORKSPACE })
    if (!started.ok) throw new Error('unreachable')
    await flush()
    const result = await store.dismiss(started.snapshot.sessionKey, 'remove')
    expect(result).toEqual({ ok: false, kind: 'worktree-dirty' })
    expect(store.list()).toHaveLength(1)
  })

  it('force passes force: true and reports worktree-remove-failed with its message', async () => {
    const removeWorktree = vi.fn(() => Promise.resolve({ outcome: 'failed' as const, message: 'boom' }))
    const store = createHostedStore(baseDeps({ getSdk: () => Promise.resolve({ query: endedQuery, renameSession: vi.fn(() => Promise.resolve(undefined)) }), removeWorktree }))
    const started = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKTREE_WORKSPACE })
    if (!started.ok) throw new Error('unreachable')
    await flush()
    const result = await store.dismiss(started.snapshot.sessionKey, 'force')
    expect(removeWorktree).toHaveBeenCalledWith('/repo/.claude/worktrees/session-a', true)
    expect(result).toEqual({ ok: false, kind: 'worktree-remove-failed', message: 'boom' })
    expect(store.list()).toHaveLength(1)
  })

  it('keep forgets the handle without calling removeWorktree, even for a worktree session', async () => {
    const removeWorktree = vi.fn(() => Promise.resolve({ outcome: 'removed' as const }))
    const store = createHostedStore(baseDeps({ getSdk: () => Promise.resolve({ query: endedQuery, renameSession: vi.fn(() => Promise.resolve(undefined)) }), removeWorktree }))
    const started = await store.start({ repoId: REPO_ID, mode: { kind: 'fresh' }, workspace: WORKTREE_WORKSPACE })
    if (!started.ok) throw new Error('unreachable')
    await flush()
    const result = await store.dismiss(started.snapshot.sessionKey, 'keep')
    expect(removeWorktree).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true })
    expect(store.list()).toEqual([])
  })
})
