// session.restore / session.restoreList / session.restoreDiscard.
import { describe, expect, it } from 'vitest'
import type { RepoId, RepositoryEntry } from '@/utils/repos'
import type { ReposListResponse } from '@/types/ipc'
import { storeStub } from '../../../fixtures/store'
import { createFakeFs } from '../../../support/fake-platform'
import { callAction, createTestContext } from '../../../support/context'

const REPO_ID = 'repo-1' as unknown as RepoId

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

const NOT_READY_ENTRY: RepositoryEntry = { id: REPO_ID, path: '/repo', displayName: 'widgets', problem: { kind: 'directory-missing' }, diagnostics: [] }

const entry = { restoreId: 'restore-1', repoId: REPO_ID, claudeSessionId: 'session-1', title: null, startedAt: 't1' }
const byCwd = { ...entry, repoId: null, cwd: '/gone' }

const missing = { ...createFakeFs(), exists: () => Promise.resolve(false) }
const NOT_A_REPO = { ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'not a repository' } as const

function contextFor(restorable: readonly (typeof entry | typeof byCwd)[], repos: ReposListResponse, extra: { restore?: () => Promise<never> } = {}) {
  return createTestContext({
    repos: { list: () => Promise.resolve(repos) },
    live: { hostedStore: storeStub({ restorable: () => Promise.resolve(restorable as never), ...extra }) },
    platform: { fs: missing, git: () => Promise.resolve(NOT_A_REPO) },
  })
}

const registry = (repositories: readonly RepositoryEntry[]): ReposListResponse => ({ ok: true, repositories })

describe('session.restoreList', () => {
  it.each([
    { name: 'a ready repository', entries: [entry], repos: registry([READY_ENTRY]), availability: { ok: true } },
    { name: 'a not-ready repository', entries: [entry], repos: registry([NOT_READY_ENTRY]), availability: { ok: false, reason: 'its folder is gone' } },
    { name: 'a failed listing', entries: [entry], repos: { ok: false, kind: 'registry-unreadable', message: 'nope' } as ReposListResponse, availability: { ok: false, reason: 'nope' } },
    { name: 'an entry restoring by folder', entries: [byCwd], repos: registry([]), availability: { ok: false, reason: "This session's folder is gone." } },
  ])('marks $name', async ({ entries, repos, availability }) => {
    const { entries: listed } = await callAction(contextFor(entries, repos), 'session.restoreList')
    expect(listed[0]?.availability).toEqual(availability)
  })

  it('carries the entry through with its origin', async () => {
    const ctx = createTestContext({ repos: { list: () => Promise.resolve(registry([READY_ENTRY])) }, live: { hostedStore: storeStub({ restorable: () => Promise.resolve([entry]) }) } })
    const { entries } = await callAction(ctx, 'session.restoreList')
    expect(entries).toEqual([{ restoreId: 'restore-1', repoId: REPO_ID, folder: null, title: null, origin: { kind: 'resumed', from: 'session-1' }, startedAt: 't1', availability: { ok: true } }])
  })
})

describe('session.restore', () => {
  it.each([
    { name: 'an id no entry carries', entries: [], repos: registry([]), expected: { ok: false, kind: 'unknown-restore' } },
    { name: 'a repository that is not ready', entries: [entry], repos: registry([NOT_READY_ENTRY]), expected: { ok: false, kind: 'repo-unavailable', reason: 'its folder is gone' } },
    { name: 'a repository that is gone', entries: [entry], repos: registry([]), expected: { ok: false, kind: 'repo-unavailable', reason: 'This repository is no longer registered.' } },
    { name: 'a folder that is gone', entries: [byCwd], repos: registry([]), expected: { ok: false, kind: 'folder-missing', path: '/gone' } },
  ])('returns $name as a value', async ({ entries, repos, expected }) => {
    await expect(callAction(contextFor(entries, repos), 'session.restore', { restoreId: 'restore-1' })).resolves.toEqual(expected)
  })

  it('restores a ready repository through the store with its resolved workspace', async () => {
    const restored: unknown[][] = []
    const hostedStore = storeStub({
      restorable: () => Promise.resolve([entry]),
      restore: (...args) => {
        restored.push(args)
        return Promise.resolve({ ok: true as const, snapshot: {} as never })
      },
    })
    const ctx = createTestContext({ repos: { list: () => Promise.resolve(registry([READY_ENTRY])) }, live: { hostedStore }, platform: { git: () => Promise.resolve(NOT_A_REPO) } })
    await callAction(ctx, 'session.restore', { restoreId: 'restore-1' })
    expect(restored).toEqual([['restore-1', { repoId: null, workspace: { folder: '/repo', root: null, worktree: null, base: null } }]])
  })

  it('rejects an empty restoreId', async () => {
    await expect(callAction(contextFor([], registry([])), 'session.restore', { restoreId: '' })).rejects.toThrow()
  })
})

describe('session.restoreDiscard', () => {
  it.each([{ restoreId: null }, { restoreId: 'restore-1' }])('discards $restoreId through the store', async ({ restoreId }) => {
    const discarded: unknown[] = []
    const hostedStore = storeStub({
      discardRestorable: (id) => {
        discarded.push(id)
        return Promise.resolve({ ok: true as const })
      },
    })
    await callAction(createTestContext({ live: { hostedStore } }), 'session.restoreDiscard', { restoreId })
    expect(discarded).toEqual([restoreId])
  })
})
