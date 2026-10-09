import { describe, expect, it } from 'vitest'
import type { CommandResult } from '../platform/run'
import type { GitRunner } from '../platform/git'
import type { RegistryDeps } from '../registry'
import type { RepoId, RepositoryEntry } from '../../shared/repos'
import type { SessionWorkspace } from '../../shared/workspace/types'
import type { SessionKey } from '../../shared/hosting/types'
import type { RecentsStore } from '../workspace/recents'
import { resolveFoldersChoose, resolveFoldersList, resolveSessionChanges } from './workspace'
import type { WorkspaceChannelDeps } from './workspace'

function ok(stdout: string): CommandResult {
  return { ok: true, stdout, stderr: '' }
}

const NOT_A_REPO: CommandResult = { ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'not a git repository' }

function fakeGit(root: string): GitRunner {
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
      vocabulary: { labels: [], disabled: [], problems: [] },
      commands: { worktrees: null, budget: null },
      concurrency: { sharedFiles: [], overlapThreshold: 2 },
      checkDispositions: {},
      overrides: [],
    },
    diagnostics: [],
  }
}

function fakeRecents(initial: readonly { path: string; lastUsedAt: string }[] = []): RecentsStore {
  let entries = initial
  return {
    load: () => Promise.resolve(entries),
    record: (path, now) => {
      entries = [{ path, lastUsedAt: now.toISOString() }, ...entries.filter((entry) => entry.path !== path)]
      return Promise.resolve()
    },
  }
}

const REGISTRY_DEPS = {} as RegistryDeps

function depsFor(overrides: Partial<WorkspaceChannelDeps>): WorkspaceChannelDeps {
  return {
    listRepositories: () => Promise.resolve({ ok: true, repositories: [] }),
    recents: fakeRecents(),
    chooseFolder: () => Promise.resolve(null),
    git: fakeGit('/repo'),
    exists: () => Promise.resolve(true),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    workspaceOf: () => Promise.resolve(null),
    computeSessionChanges: () => Promise.resolve({ ok: false, kind: 'not-git', message: 'unused' }),
    ...overrides,
  }
}

describe('resolveFoldersList', () => {
  it('throws for a non-void request', async () => {
    await expect(resolveFoldersList(REGISTRY_DEPS, {} as unknown as void, depsFor({}))).rejects.toThrow("'folders:list' takes no payload")
  })

  it('lists ready registry repos first', async () => {
    const repositories = [readyRepo('/repo')]
    const deps = depsFor({ listRepositories: () => Promise.resolve({ ok: true, repositories }) })
    const result = await resolveFoldersList(REGISTRY_DEPS, undefined, deps)
    expect(result.folders).toHaveLength(1)
    expect(result.folders[0]?.path).toBe('/repo')
  })

  it('appends recents after registry repos, most recent first', async () => {
    const recents = fakeRecents([
      { path: '/old', lastUsedAt: '2026-01-01T00:00:00.000Z' },
      { path: '/new', lastUsedAt: '2026-01-02T00:00:00.000Z' },
    ])
    const deps = depsFor({ recents, git: fakeGit('/old') })
    const result = await resolveFoldersList(REGISTRY_DEPS, undefined, deps)
    expect(result.folders.map((folder) => folder.path)).toEqual(['/old', '/new'])
  })

  it('dedupes a recent entry that matches a registry repo path', async () => {
    const repositories = [readyRepo('/repo')]
    const recents = fakeRecents([{ path: '/repo', lastUsedAt: '2026-01-01T00:00:00.000Z' }])
    const deps = depsFor({ listRepositories: () => Promise.resolve({ ok: true, repositories }), recents })
    const result = await resolveFoldersList(REGISTRY_DEPS, undefined, deps)
    expect(result.folders).toHaveLength(1)
  })

  it('drops a recent folder that no longer exists', async () => {
    const recents = fakeRecents([{ path: '/gone', lastUsedAt: '2026-01-01T00:00:00.000Z' }])
    const deps = depsFor({ recents, exists: () => Promise.resolve(false) })
    const result = await resolveFoldersList(REGISTRY_DEPS, undefined, deps)
    expect(result.folders).toHaveLength(0)
  })
})

describe('resolveFoldersChoose', () => {
  it('returns cancelled when the picker is cancelled', async () => {
    const result = await resolveFoldersChoose(REGISTRY_DEPS, undefined, depsFor({ chooseFolder: () => Promise.resolve(null) }))
    expect(result).toEqual({ outcome: 'cancelled' })
  })

  it('records the chosen folder in recents and returns it as chosen', async () => {
    const recents = fakeRecents()
    const deps = depsFor({ chooseFolder: () => Promise.resolve('/picked'), recents, git: fakeGit('/picked') })
    const result = await resolveFoldersChoose(REGISTRY_DEPS, undefined, deps)
    expect(result.outcome).toBe('chosen')
    await expect(recents.load()).resolves.toEqual([{ path: '/picked', lastUsedAt: '2026-01-01T00:00:00.000Z' }])
  })
})

const SESSION_KEY = 'hosted-1' as SessionKey

describe('resolveSessionChanges', () => {
  it('throws for an empty sessionKey', async () => {
    await expect(resolveSessionChanges({ sessionKey: '' as SessionKey }, depsFor({}))).rejects.toThrow("non-empty 'sessionKey'")
  })

  it('reports unknown-session when workspaceOf resolves null', async () => {
    const result = await resolveSessionChanges({ sessionKey: SESSION_KEY }, depsFor({ workspaceOf: () => Promise.resolve(null) }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('unknown-session')
  })

  it('delegates to computeSessionChanges for a resolved workspace', async () => {
    const workspace: SessionWorkspace = { folder: '/repo', root: '/repo', worktree: null, base: { sha: 'abc', label: 'main' } }
    const deps = depsFor({
      workspaceOf: () => Promise.resolve(workspace),
      computeSessionChanges: () => Promise.resolve({ ok: true, base: workspace.base, files: [], untracked: [], binary: [], summary: [], truncated: false, readAt: '2026-01-01T00:00:00.000Z' }),
    })
    const result = await resolveSessionChanges({ sessionKey: SESSION_KEY }, deps)
    expect(result.ok).toBe(true)
  })
})
