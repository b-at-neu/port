import { describe, expect, it } from 'vitest'
import type { RepoId, RepositoryEntry } from '@/utils/repos'
import type { SessionKey } from '@/types/hosting'
import type { CommandResult } from '@/types/platform'
import { storeStub } from '../../../fixtures/store'
import { fakeEngine, callAction, createTestContext } from '../../../support/context'
import { createFakeFs } from '../../../support/fake-platform'
import { toFolderId } from '@/main/repos/worktree/resolve'
import { pathOps } from '@/main/platform/paths'

const REPO_ID = 'repo-1' as unknown as RepoId
const KEY = 'hosted-1' as SessionKey

const READY_ENTRY: RepositoryEntry = {
  id: REPO_ID,
  path: '/repo',
  displayName: 'widgets',
  status: 'ready',
  config: {
    repo: 'acme/widgets',
    owner: 'acme',
    name: 'widgets',
    branches: { integration: 'dev', production: 'main' },
    models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
    modules: { approvalGate: true, release: true, scope: true },
    reviewCycleCap: 3,
    vocabulary: { labels: [], disabled: [], problems: [] },
    commands: { worktrees: null, budget: null },
    concurrency: { sharedFiles: [], overlapThreshold: 2 },
    sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
    checkDispositions: {},
    overrides: [],
  },
  diagnostics: [],
}

const FOLDER = { kind: 'folder' as const, folderId: toFolderId(pathOps.pathKey('/repo')) as string, worktree: false }
const WORKSPACE = { folder: '/repo', root: '/repo', worktree: null, base: { sha: 'abc123', label: 'main' } }

function ok(stdout: string): CommandResult {
  return { ok: true, stdout, stderr: '' }
}

const engine = fakeEngine({ listSessions: () => Promise.resolve({ ok: true, sessions: [] }) })

describe('session.start', () => {
  it('starts a folder target in its workspace and records the folder in recents', async () => {
    const started: unknown[] = []
    const hostedStore = storeStub({
      start: (params) => {
        started.push(params)
        return Promise.resolve({ ok: true as const, snapshot: {} as never })
      },
    })
    const ctx = createTestContext({ repositories: [READY_ENTRY], live: { hostedStore, engine }, platform: { git: (args) => Promise.resolve(args.includes('--abbrev-ref') ? ok('main\n') : args.includes('--show-toplevel') ? ok('/repo\n') : ok('abc123\n')), fs: { ...createFakeFs(), exists: () => Promise.resolve(true) } } })
    const result = await callAction(ctx, 'session.start', { target: FOLDER, mode: { kind: 'fresh' } })
    expect(result.ok).toBe(true)
    expect(started).toHaveLength(1)
    await expect(ctx.stores.recents.load()).resolves.toEqual([{ path: '/repo', lastUsedAt: ctx.clock.now().toISOString() }])
  })

  it('rejects a folder id naming no registered or recent folder, never reaching the store', async () => {
    const ctx = createTestContext({ live: { hostedStore: storeStub(), engine } })
    await expect(callAction(ctx, 'session.start', { target: { ...FOLDER, folderId: 'unknown' }, mode: { kind: 'fresh' } })).rejects.toThrow()
  })

  it('returns a typed target failure without ever reaching the store', async () => {
    const ctx = createTestContext({ repositories: [READY_ENTRY], live: { hostedStore: storeStub(), engine } })
    const result = await callAction(ctx, 'session.start', { target: FOLDER, mode: { kind: 'fresh' } })
    expect(result).toMatchObject({ ok: false, kind: 'folder-missing' })
  })

  it('rejects a transcript target started fresh', async () => {
    const ctx = createTestContext({ live: { hostedStore: storeStub(), engine } })
    await expect(callAction(ctx, 'session.start', { target: { kind: 'transcript' }, mode: { kind: 'fresh' } })).rejects.toThrow()
  })
})

describe('session.send', () => {
  it('marks the send as the operator’s own', async () => {
    const sent: unknown[][] = []
    const hostedStore = storeStub({
      send: (...args) => {
        sent.push(args)
        return { ok: true as const, uuid: 'u', queued: true }
      },
    })
    const ctx = createTestContext({ live: { hostedStore } })
    await callAction(ctx, 'session.send', { sessionKey: KEY, text: 'hi' })
    expect(sent).toEqual([[KEY, 'hi', [], { source: 'operator' }]])
  })
})

describe('session.files', () => {
  it('reports unknown-session for a key naming no live handle', async () => {
    const ctx = createTestContext({ live: { hostedStore: storeStub({ cwdOf: () => null }) } })
    await expect(callAction(ctx, 'session.files', { sessionKey: KEY })).resolves.toEqual({ ok: false, kind: 'unknown-session' })
  })

  it("lists the handle's own files from git", async () => {
    const ctx = createTestContext({ live: { hostedStore: storeStub({ cwdOf: () => '/repo' }) }, platform: { git: () => Promise.resolve(ok('a.ts\nb.ts\n')) } })
    const result = await callAction(ctx, 'session.files', { sessionKey: KEY })
    expect(result).toMatchObject({ ok: true, files: ['a.ts', 'b.ts'] })
  })

  it('reports unreadable, never an empty list, when git and the walk both fail', async () => {
    const failed: CommandResult = { ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'denied' }
    const fs = { ...createFakeFs(), readdir: () => Promise.reject(new Error('denied')) }
    const ctx = createTestContext({ live: { hostedStore: storeStub({ cwdOf: () => '/repo' }) }, platform: { git: () => Promise.resolve(failed), fs } })
    const result = await callAction(ctx, 'session.files', { sessionKey: KEY })
    expect(result).toMatchObject({ ok: false, kind: 'unreadable' })
  })
})

describe('session.dismiss', () => {
  it('rejects a non-keep choice for a non-worktree session', async () => {
    const hostedStore = storeStub({ snapshotOf: () => ({ workspace: WORKSPACE }) as never })
    const ctx = createTestContext({ live: { hostedStore } })
    await expect(callAction(ctx, 'session.dismiss', { sessionKey: KEY, worktree: 'remove' })).rejects.toThrow()
  })
})
