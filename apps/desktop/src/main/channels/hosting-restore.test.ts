// session:restore / :list / :discard — split out of hosting.test.ts to stay under the file size limit.
import { describe, expect, it, vi } from 'vitest'
import type { RepoId } from '../../shared/repos'
import type { RegistryDeps } from '../registry'
import type { HostedStore } from '../hosting/store'
import type { ResolveStartTargetDeps, ResolvedStartTarget } from '../workspace/target'
import { resolveSessionRestore, resolveSessionRestoreDiscard, resolveSessionRestoreList } from './hosting'
import type { HostingChannelDeps } from './hosting'

const REPO_ID = 'repo-1' as unknown as RepoId

const registryDeps: RegistryDeps = {
  registryDir: '/registry',
  git: () => {
    throw new Error('git should not be invoked directly by the hosting channel')
  },
  chooseDirectory: () => Promise.resolve(null),
}

const READY_ENTRY = {
  id: REPO_ID,
  path: '/repo',
  displayName: 'widgets',
  status: 'ready' as const,
  config: {
    repo: 'acme/widgets',
    owner: 'acme',
    name: 'widgets',
    branches: { integration: 'dev', production: 'main' },
    models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
    modules: { approvalGate: true, release: true, scope: true },
    reviewCycleCap: 3,
    vocabulary: {} as never,
    commands: { worktrees: null, budget: null },
    concurrency: { sharedFiles: [], overlapThreshold: 2 },
    checkDispositions: {},
    overrides: [],
  },
  diagnostics: [],
}

const NOT_READY_ENTRY = { id: REPO_ID, path: '/repo', displayName: 'widgets', problem: { kind: 'directory-missing' as const }, diagnostics: [] }
const WORKSPACE = { folder: '/repo', root: '/repo', worktree: null, base: null }

function storeStub(overrides: Partial<HostedStore> = {}): HostedStore {
  return {
    start: () => {
      throw new Error('start should not be invoked in this case')
    },
    send: () => {
      throw new Error('send should not be invoked in this case')
    },
    interrupt: () => {
      throw new Error('interrupt should not be invoked in this case')
    },
    close: () => {
      throw new Error('close should not be invoked in this case')
    },
    attach: () => {
      throw new Error('attach should not be invoked in this case')
    },
    list: () => {
      throw new Error('list should not be invoked in this case')
    },
    closeAll: () => {
      throw new Error('closeAll should not be invoked in this case')
    },
    answerPermission: () => {
      throw new Error('answerPermission should not be invoked in this case')
    },
    invoke: () => {
      throw new Error('invoke should not be invoked in this case')
    },
    dismiss: () => {
      throw new Error('dismiss should not be invoked in this case')
    },
    snapshotOf: () => {
      throw new Error('snapshotOf should not be invoked in this case')
    },
    cwdOf: () => {
      throw new Error('cwdOf should not be invoked in this case')
    },
    capacity: () => {
      throw new Error('capacity should not be invoked in this case')
    },
    setLimit: () => {
      throw new Error('setLimit should not be invoked in this case')
    },
    defaults: () => {
      throw new Error('defaults should not be invoked in this case')
    },
    setDefaults: () => {
      throw new Error('setDefaults should not be invoked in this case')
    },
    marks: () => {
      throw new Error('marks should not be invoked in this case')
    },
    setMark: () => {
      throw new Error('setMark should not be invoked in this case')
    },
    rename: () => {
      throw new Error('rename should not be invoked in this case')
    },
    restorable: () => {
      throw new Error('restorable should not be invoked in this case')
    },
    restore: () => {
      throw new Error('restore should not be invoked in this case')
    },
    discardRestorable: () => {
      throw new Error('discardRestorable should not be invoked in this case')
    },
    setControls: () => {
      throw new Error('setControls should not be invoked in this case')
    },
    answerQuestion: () => {
      throw new Error('answerQuestion should not be invoked in this case')
    },
    answerPlan: () => {
      throw new Error('answerPlan should not be invoked in this case')
    },
    stopTask: () => {
      throw new Error('stopTask should not be invoked in this case')
    },
    ...overrides,
  }
}

function targetDepsStub(overrides: Partial<ResolveStartTargetDeps> = {}): Omit<ResolveStartTargetDeps, 'repositories'> {
  return {
    git: () => {
      throw new Error('git should not be invoked directly in this case')
    },
    recents: { load: () => Promise.resolve([]), record: () => Promise.resolve() },
    exists: () => Promise.resolve(true),
    readSessions: () => Promise.resolve({ ok: true, sessions: [] }),
    createWorktree: () => Promise.resolve({ ok: false, message: 'should not be called' }),
    ...overrides,
  }
}

function depsWith(overrides: Partial<HostingChannelDeps> = {}): HostingChannelDeps {
  return {
    listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }),
    store: storeStub(),
    listSessionFiles: () => {
      throw new Error('listSessionFiles should not be invoked in this case')
    },
    resolveStartTarget: () => Promise.resolve({ ok: true, cwd: '/repo', workspace: WORKSPACE, repoId: REPO_ID, createdWorktree: null, recordPath: '/repo' } satisfies ResolvedStartTarget),
    targetDeps: targetDepsStub(),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    removeCreatedWorktree: () => Promise.resolve(),
    ...overrides,
  }
}

describe('resolveSessionRestoreList', () => {
  it('rejects a payload', async () => {
    await expect(resolveSessionRestoreList(registryDeps, {} as unknown as void, depsWith())).rejects.toThrow("'session:restore:list' takes no payload")
  })

  it('marks a ready repository available', async () => {
    const restorable = vi.fn(() =>
      Promise.resolve([{ restoreId: 'restore-1', repoId: REPO_ID, claudeSessionId: 'session-1', title: 'Title', startedAt: 't1' }]),
    )
    const result = await resolveSessionRestoreList(registryDeps, undefined, depsWith({ store: storeStub({ restorable }) }))
    expect(result.entries).toEqual([
      { restoreId: 'restore-1', repoId: REPO_ID, folder: null, title: 'Title', origin: { kind: 'resumed', from: 'session-1' }, startedAt: 't1', availability: { ok: true } },
    ])
  })

  it('marks a not-ready repository unavailable with its problem reason', async () => {
    const restorable = vi.fn(() =>
      Promise.resolve([{ restoreId: 'restore-1', repoId: REPO_ID, claudeSessionId: 'session-1', title: null, startedAt: 't1' }]),
    )
    const deps = depsWith({ listRepositories: () => Promise.resolve({ ok: true, repositories: [NOT_READY_ENTRY] }), store: storeStub({ restorable }) })
    const result = await resolveSessionRestoreList(registryDeps, undefined, deps)
    expect(result.entries[0]?.availability).toEqual({ ok: false, reason: 'its folder is gone' })
  })

  it('marks every entry unavailable when the listing itself fails', async () => {
    const restorable = vi.fn(() =>
      Promise.resolve([{ restoreId: 'restore-1', repoId: REPO_ID, claudeSessionId: 'session-1', title: null, startedAt: 't1' }]),
    )
    const deps = depsWith({ listRepositories: () => Promise.resolve({ ok: false, kind: 'registry-unreadable', message: 'nope' }), store: storeStub({ restorable }) })
    const result = await resolveSessionRestoreList(registryDeps, undefined, deps)
    expect(result.entries[0]?.availability).toEqual({ ok: false, reason: 'nope' })
  })

  it('an entry carrying cwd restores by folder — availability is just exists(cwd)', async () => {
    const restorable = vi.fn(() =>
      Promise.resolve([{ restoreId: 'restore-1', repoId: null, claudeSessionId: 'session-1', title: null, startedAt: 't1', cwd: '/gone' }]),
    )
    const deps = depsWith({ store: storeStub({ restorable }), targetDeps: targetDepsStub({ exists: () => Promise.resolve(false) }) })
    const result = await resolveSessionRestoreList(registryDeps, undefined, deps)
    expect(result.entries[0]).toMatchObject({ folder: '/gone', availability: { ok: false, reason: "This session's folder is gone." } })
  })
})

describe('resolveSessionRestore', () => {
  it('rejects a missing restoreId', async () => {
    await expect(resolveSessionRestore(registryDeps, { restoreId: '' }, depsWith())).rejects.toThrow("'session:restore' requires a non-empty 'restoreId'")
  })

  it('reports unknown-restore for an id no entry carries', async () => {
    const deps = depsWith({ store: storeStub({ restorable: () => Promise.resolve([]) }) })
    await expect(resolveSessionRestore(registryDeps, { restoreId: 'restore-1' }, deps)).resolves.toEqual({ ok: false, kind: 'unknown-restore' })
  })

  it('reports repo-unavailable rather than throwing when the repository is not ready', async () => {
    const restorable = () => Promise.resolve([{ restoreId: 'restore-1', repoId: REPO_ID, claudeSessionId: 'session-1', title: null, startedAt: 't1' }])
    const deps = depsWith({ listRepositories: () => Promise.resolve({ ok: true, repositories: [NOT_READY_ENTRY] }), store: storeStub({ restorable }) })
    await expect(resolveSessionRestore(registryDeps, { restoreId: 'restore-1' }, deps)).resolves.toEqual({ ok: false, kind: 'repo-unavailable', reason: 'its folder is gone' })
  })

  it('resolves the ready path itself and delegates to the store', async () => {
    const restorable = () => Promise.resolve([{ restoreId: 'restore-1', repoId: REPO_ID, claudeSessionId: 'session-1', title: null, startedAt: 't1' }])
    const restore = vi.fn(() => Promise.resolve({ ok: true as const, snapshot: {} as never }))
    const deps = depsWith({ store: storeStub({ restorable, restore }), targetDeps: targetDepsStub({ git: () => Promise.resolve({ ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'not a repository' }) }) })
    await resolveSessionRestore(registryDeps, { restoreId: 'restore-1' }, deps)
    expect(restore).toHaveBeenCalledWith('restore-1', { repoId: null, workspace: { folder: '/repo', root: null, worktree: null, base: null } })
  })

  it('restores by cwd when the entry carries one, returning folder-missing when it is gone', async () => {
    const restorable = () => Promise.resolve([{ restoreId: 'restore-1', repoId: null, claudeSessionId: 'session-1', title: null, startedAt: 't1', cwd: '/gone' }])
    const deps = depsWith({ store: storeStub({ restorable }), targetDeps: targetDepsStub({ exists: () => Promise.resolve(false) }) })
    await expect(resolveSessionRestore(registryDeps, { restoreId: 'restore-1' }, deps)).resolves.toEqual({ ok: false, kind: 'folder-missing', path: '/gone' })
  })
})

describe('resolveSessionRestoreDiscard', () => {
  it('rejects an empty-string restoreId', () => {
    expect(() => resolveSessionRestoreDiscard({ restoreId: '' }, depsWith())).toThrow("'session:restore:discard' requires 'restoreId' to be null or a non-empty string")
  })

  it('delegates null through to discard every entry', () => {
    const discardRestorable = vi.fn(() => Promise.resolve({ ok: true as const }))
    void resolveSessionRestoreDiscard({ restoreId: null }, depsWith({ store: storeStub({ discardRestorable }) }))
    expect(discardRestorable).toHaveBeenCalledWith(null)
  })

  it('delegates a specific restoreId', () => {
    const discardRestorable = vi.fn(() => Promise.resolve({ ok: true as const }))
    void resolveSessionRestoreDiscard({ restoreId: 'restore-1' }, depsWith({ store: storeStub({ discardRestorable }) }))
    expect(discardRestorable).toHaveBeenCalledWith('restore-1')
  })
})
