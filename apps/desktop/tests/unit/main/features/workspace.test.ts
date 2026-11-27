import { describe, expect, it } from 'vitest'
import type { CommandResult, GitRunner } from '@/types/platform'
import type { RecentsStore } from '@/types/workspace'
import type { RepoId, RepositoryEntry } from '@/utils/repos'
import { resolveDisplayVocabulary } from '@/utils/labels/display'
import { storeStub } from '../../../fixtures/store'
import { createFakeFs } from '../../../support/fake-platform'
import { callAction, createTestContext } from '../../../support/context'

function ok(stdout: string): CommandResult {
  return { ok: true, stdout, stderr: '' }
}

const NOT_A_REPO: CommandResult = { ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'not a git repository' }

function gitAt(root: string): GitRunner {
  return (args) => {
    if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return Promise.resolve(ok(`${root}\n`))
    if (args[0] === 'rev-parse' && args.includes('HEAD')) return Promise.resolve(ok('abc123\n'))
    if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) return Promise.resolve(ok('main\n'))
    if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return Promise.resolve(ok('.git\n'))
    return Promise.resolve(NOT_A_REPO)
  }
}

function readyRepo(path: string): RepositoryEntry {
  return {
    id: path as RepoId,
    path,
    displayName: path,
    status: 'ready',
    config: {
      repo: 'acme/widgets',
      owner: 'acme',
      name: 'widgets',
      branches: { integration: 'dev', production: 'main' },
      models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
      modules: { approvalGate: true, release: true, scope: true },
      reviewCycleCap: 5,
      displayVocabulary: resolveDisplayVocabulary({}),
      commands: { worktrees: null, budget: null },
      concurrency: { sharedFiles: [], overlapThreshold: 2 },
      sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
      checkDispositions: {},
      overrides: [],
    },
    diagnostics: [],
  }
}

function recentsOf(initial: readonly { path: string; lastUsedAt: string }[] = []): RecentsStore {
  let entries = initial
  return {
    load: () => Promise.resolve(entries),
    record: (path, now) => {
      entries = [{ path, lastUsedAt: now.toISOString() }, ...entries.filter((entry) => entry.path !== path)]
      return Promise.resolve()
    },
  }
}

const existing = { ...createFakeFs(), exists: () => Promise.resolve(true) }

describe('folders.list', () => {
  it('lists ready registry repositories first', async () => {
    const ctx = createTestContext({ repositories: [readyRepo('/repo')], stores: { recents: recentsOf() }, platform: { git: gitAt('/repo'), fs: existing } })
    const { folders } = await callAction(ctx, 'folders.list')
    expect(folders.map((folder) => folder.path)).toEqual(['/repo'])
  })

  it('appends recents after registry repositories, most recent first', async () => {
    const recents = recentsOf([
      { path: '/old', lastUsedAt: '2026-01-01T00:00:00.000Z' },
      { path: '/new', lastUsedAt: '2026-01-02T00:00:00.000Z' },
    ])
    const ctx = createTestContext({ stores: { recents }, platform: { git: gitAt('/old'), fs: existing } })
    const { folders } = await callAction(ctx, 'folders.list')
    expect(folders.map((folder) => folder.path)).toEqual(['/old', '/new'])
  })

  it('shows a recent folder that is also a registry repository once', async () => {
    const recents = recentsOf([{ path: '/repo', lastUsedAt: '2026-01-01T00:00:00.000Z' }])
    const ctx = createTestContext({ repositories: [readyRepo('/repo')], stores: { recents }, platform: { git: gitAt('/repo'), fs: existing } })
    const { folders } = await callAction(ctx, 'folders.list')
    expect(folders).toHaveLength(1)
  })

  it('drops a recent folder that no longer exists', async () => {
    const recents = recentsOf([{ path: '/gone', lastUsedAt: '2026-01-01T00:00:00.000Z' }])
    const ctx = createTestContext({ stores: { recents }, platform: { git: gitAt('/gone'), fs: { ...existing, exists: () => Promise.resolve(false) } } })
    const { folders } = await callAction(ctx, 'folders.list')
    expect(folders).toEqual([])
  })
})

describe('folders.choose', () => {
  it('returns cancelled when the picker is cancelled', async () => {
    const ctx = createTestContext({ platform: { dialogs: { chooseDirectory: () => Promise.resolve(null), chooseFolder: () => Promise.resolve(null), chooseSavePath: () => Promise.resolve(null) } } })
    await expect(callAction(ctx, 'folders.choose')).resolves.toEqual({ outcome: 'cancelled' })
  })

  it('records the chosen folder in recents and returns it', async () => {
    const recents = recentsOf()
    const ctx = createTestContext({
      stores: { recents },
      platform: { git: gitAt('/picked'), dialogs: { chooseDirectory: () => Promise.resolve(null), chooseFolder: () => Promise.resolve('/picked'), chooseSavePath: () => Promise.resolve(null) } },
    })
    const result = await callAction(ctx, 'folders.choose')
    expect(result.outcome).toBe('chosen')
    await expect(recents.load()).resolves.toEqual([{ path: '/picked', lastUsedAt: ctx.clock.now().toISOString() }])
  })
})

describe('session.changes', () => {
  it('reports unknown-session for a key naming no open session', async () => {
    const ctx = createTestContext({ live: { hostedStore: storeStub({ snapshotOf: () => null }) } })
    const result = await callAction(ctx, 'session.changes', { sessionKey: 'hosted-1' as never })
    expect(result).toMatchObject({ ok: false, kind: 'unknown-session' })
  })

  it('reads the changes of an open session through its workspace', async () => {
    const workspace = { folder: '/repo', root: '/repo', worktree: null, base: { sha: 'abc', label: 'main' } }
    const ctx = createTestContext({ live: { hostedStore: storeStub({ snapshotOf: () => ({ workspace }) as never }) }, platform: { git: () => Promise.resolve(ok('')) } })
    const result = await callAction(ctx, 'session.changes', { sessionKey: 'hosted-1' as never })
    expect(result.ok).toBe(true)
  })
})
