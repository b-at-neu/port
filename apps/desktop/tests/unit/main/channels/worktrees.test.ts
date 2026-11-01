import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { ReposListResponse } from '@/types/ipc'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { ForcedReclaim, ReclaimedWorktree, RunPurgeParams, RunReclaimParams, WorktreesPurgeResult, WorktreesReclaimResult } from '@/types/reclaimer'
import type { PurgeAuditEntry, ReclaimAuditEntry } from '@/types/writes'
import { resolveWorktreesPurge, resolveWorktreesReclaim } from '@/main/channels/worktrees'
import type { WorktreesPurgeDeps, WorktreesReclaimDeps } from '@/main/channels/worktrees'
import type { RegistryDeps } from '@/types/registry'

const REPO_ID = 'repo-1' as unknown as RepoId

const registryDeps: RegistryDeps = {
  registryDir: '/registry',
  git: () => {
    throw new Error('git should not be invoked directly by resolveWorktreesReclaim')
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
    vocabulary: resolveVocabulary({}),
    commands: { worktrees: 'node scripts/worktrees.mjs', budget: null },
    concurrency: { sharedFiles: [], overlapThreshold: 2 },
    sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
    checkDispositions: {},
    overrides: [],
  },
  diagnostics: [],
}

function reclaimed(overrides: Partial<ReclaimedWorktree> = {}): ReclaimedWorktree {
  return { path: '/repo/.claude/worktrees/impl-36', pathBasename: 'impl-36', issue: 36, outcome: 'removed', error: null, branchDeleted: true, ...overrides }
}

function depsWith(overrides: Partial<WorktreesReclaimDeps>): WorktreesReclaimDeps {
  const appendedCalls: ReclaimAuditEntry[] = []
  return {
    listRepositories: () => Promise.resolve({ ok: true, repositories: [] } as ReposListResponse),
    runReclaim: () => {
      throw new Error('runReclaim should not be invoked in this case')
    },
    appendAudit: (dir, entry) => {
      appendedCalls.push(entry as ReclaimAuditEntry)
      return Promise.resolve({ ok: true })
    },
    ...overrides,
  }
}

describe('resolveWorktreesReclaim', () => {
  it('rejects a missing id', async () => {
    await expect(resolveWorktreesReclaim(registryDeps, { id: undefined as unknown as RepoId, issue: null, force: null }, '/audit', depsWith({}))).rejects.toThrow(
      "'worktrees:reclaim' requires a non-empty 'repoId'",
    )
  })

  it('rejects a negative issue', async () => {
    await expect(resolveWorktreesReclaim(registryDeps, { id: REPO_ID, issue: -1, force: null }, '/audit', depsWith({}))).rejects.toThrow(
      "'worktrees:reclaim' requires 'issue' to be null or a positive integer",
    )
  })

  it('rejects a repository that is not ready', async () => {
    const deps = depsWith({
      listRepositories: () =>
        Promise.resolve({ ok: true, repositories: [{ id: REPO_ID, path: '/repo', displayName: 'widgets', problem: { kind: 'directory-missing' as const }, diagnostics: [] }] }),
    })
    await expect(resolveWorktreesReclaim(registryDeps, { id: REPO_ID, issue: null, force: null }, '/audit', deps)).rejects.toThrow(
      "'worktrees:reclaim' requires a 'ready' repository, got 'directory-missing'",
    )
  })

  it('appends one applied audit entry on a full success', async () => {
    let auditedEntry: ReclaimAuditEntry | undefined
    const deps = depsWith({
      listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }),
      runReclaim: () =>
        Promise.resolve({ ok: true, removed: 1, results: [reclaimed()], readAt: 't', call: ['bin/worktrees.mjs'] } satisfies WorktreesReclaimResult),
      appendAudit: (_dir, entry) => {
        auditedEntry = entry as ReclaimAuditEntry
        return Promise.resolve({ ok: true })
      },
    })
    const result = await resolveWorktreesReclaim(registryDeps, { id: REPO_ID, issue: null, force: null }, '/audit', deps)
    expect(result.ok).toBe(true)
    expect(auditedEntry).toMatchObject({
      action: 'worktree-reclaim',
      removed: ['impl-36'],
      failed: [],
      result: 'applied',
      failure: null,
      call: ['bin/worktrees.mjs'],
    })
  })

  it('appends a partial-result audit entry when some candidates failed', async () => {
    let auditedEntry: ReclaimAuditEntry | undefined
    const deps = depsWith({
      listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }),
      runReclaim: () =>
        Promise.resolve({
          ok: true,
          removed: 0,
          results: [reclaimed({ outcome: 'failed', error: 'locked', branchDeleted: null })],
          readAt: 't',
          call: ['bin/worktrees.mjs'],
        } satisfies WorktreesReclaimResult),
      appendAudit: (_dir, entry) => {
        auditedEntry = entry as ReclaimAuditEntry
        return Promise.resolve({ ok: true })
      },
    })
    const result = await resolveWorktreesReclaim(registryDeps, { id: REPO_ID, issue: 36, force: null }, '/audit', deps)
    expect(result.ok).toBe(true)
    expect(auditedEntry).toMatchObject({ issue: 36, removed: [], failed: ['impl-36'], result: 'partial' })
  })

  it('appends a failed audit entry when the reclaim itself failed, aborts included', async () => {
    let auditedEntry: ReclaimAuditEntry | undefined
    const deps = depsWith({
      listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }),
      runReclaim: () =>
        Promise.resolve({
          ok: false,
          kind: 'script-failed',
          message: 'boom',
          readAt: 't',
          call: ['bin/worktrees.mjs'],
        } satisfies WorktreesReclaimResult),
      appendAudit: (_dir, entry) => {
        auditedEntry = entry as ReclaimAuditEntry
        return Promise.resolve({ ok: true })
      },
    })
    const result = await resolveWorktreesReclaim(registryDeps, { id: REPO_ID, issue: null, force: null }, '/audit', deps)
    expect(result.ok).toBe(false)
    expect(auditedEntry).toMatchObject({ result: 'failed', failure: 'script-failed', call: ['bin/worktrees.mjs'] })
  })

  it('an audit append failure never changes the already-computed result', async () => {
    const deps = depsWith({
      listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }),
      runReclaim: () =>
        Promise.resolve({ ok: true, removed: 1, results: [reclaimed()], readAt: 't', call: ['bin/worktrees.mjs'] } satisfies WorktreesReclaimResult),
      appendAudit: () => Promise.resolve({ ok: false, message: 'disk on fire' }),
    })
    const result = await resolveWorktreesReclaim(registryDeps, { id: REPO_ID, issue: null, force: null }, '/audit', deps)
    expect(result).toEqual({ ok: true, removed: 1, results: [reclaimed()], readAt: 't', call: ['bin/worktrees.mjs'] })
  })

  describe('force', () => {
    const FORCE = { path: '/repo/.claude/worktrees/impl-51', unlock: true, forceDirty: false }

    function forcedDeps(seen: { params?: RunReclaimParams; audited?: ReclaimAuditEntry }): WorktreesReclaimDeps {
      return depsWith({
        listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }),
        runReclaim: (params) => {
          seen.params = params
          return Promise.resolve({ ok: true, removed: 1, results: [reclaimed()], readAt: 't', call: ['bin/worktrees.mjs'] } satisfies WorktreesReclaimResult)
        },
        appendAudit: (_dir, entry) => {
          seen.audited = entry as ReclaimAuditEntry
          return Promise.resolve({ ok: true })
        },
      })
    }

    it.each([
      ['no flag set', { ...FORCE, unlock: false }, "requires 'force' to set at least one flag"],
      ['a non-boolean flag', { ...FORCE, forceDirty: 'yes' }, "'force.unlock' and 'force.forceDirty' to be booleans"],
      ['an empty path', { ...FORCE, path: '' }, "null or carry a non-empty 'path'"],
      ['a path outside the repository', { ...FORCE, path: '/elsewhere/impl-51' }, "'force.path' to be inside the repository"],
      ['the repository root itself', { ...FORCE, path: '/repo' }, "'force.path' to be inside the repository"],
    ])('rejects %s before anything is spawned', async (_label, force, message) => {
      const seen: { params?: RunReclaimParams } = {}
      await expect(resolveWorktreesReclaim(registryDeps, { id: REPO_ID, issue: null, force: force as ForcedReclaim }, '/audit', forcedDeps(seen))).rejects.toThrow(message)
      expect(seen.params).toBeUndefined()
    })

    it('rejects a force combined with an issue', async () => {
      const seen: { params?: RunReclaimParams } = {}
      await expect(resolveWorktreesReclaim(registryDeps, { id: REPO_ID, issue: 51, force: FORCE }, '/audit', forcedDeps(seen))).rejects.toThrow(
        "requires 'issue' to be null when 'force' is set",
      )
      expect(seen.params).toBeUndefined()
    })

    it('passes the confirmed force to the run and audits its flags', async () => {
      const seen: { params?: RunReclaimParams; audited?: ReclaimAuditEntry } = {}
      await resolveWorktreesReclaim(registryDeps, { id: REPO_ID, issue: null, force: FORCE }, '/audit', forcedDeps(seen))
      expect(seen.params?.force).toEqual(FORCE)
      expect(seen.audited).toMatchObject({ force: { unlock: true, forceDirty: false } })
    })

    it('audits a plain reclaim with no force', async () => {
      const seen: { audited?: ReclaimAuditEntry } = {}
      await resolveWorktreesReclaim(registryDeps, { id: REPO_ID, issue: null, force: null }, '/audit', forcedDeps(seen))
      expect(seen.audited).toMatchObject({ force: null })
    })
  })
})

describe('resolveWorktreesPurge', () => {
  const PATH = '/repo/.claude/worktrees/impl-29-stale'

  function purgeDeps(seen: { params?: RunPurgeParams; audited: PurgeAuditEntry[] }, result: WorktreesPurgeResult): WorktreesPurgeDeps {
    return {
      listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }),
      runPurge: (params) => {
        seen.params = params
        return Promise.resolve(result)
      },
      appendAudit: (_dir, entry) => {
        seen.audited.push(entry as PurgeAuditEntry)
        return Promise.resolve({ ok: true })
      },
    }
  }

  const deleted: WorktreesPurgeResult = { ok: true, outcome: 'deleted', pathBasename: 'impl-29-stale', message: null, cause: null, readAt: 't', call: ['bin/worktrees.mjs'] }

  it.each([
    ['an empty path', '', "requires 'path' to be a non-empty string"],
    ['a path outside the repository', '/elsewhere/impl-29-stale', "requires 'path' to be inside the repository"],
  ])('rejects %s before anything is spawned', async (_label, path, message) => {
    const seen = { audited: [] as PurgeAuditEntry[] } as { params?: RunPurgeParams; audited: PurgeAuditEntry[] }
    await expect(resolveWorktreesPurge(registryDeps, { id: REPO_ID, path }, '/audit', purgeDeps(seen, deleted))).rejects.toThrow(message)
    expect(seen.params).toBeUndefined()
    expect(seen.audited).toEqual([])
  })

  it('rejects a missing id', async () => {
    const seen = { audited: [] as PurgeAuditEntry[] }
    await expect(resolveWorktreesPurge(registryDeps, { id: undefined as unknown as RepoId, path: PATH }, '/audit', purgeDeps(seen, deleted))).rejects.toThrow(
      "'worktrees:purge' requires a non-empty 'repoId'",
    )
  })

  it('runs the purge for the one path and audits its basename once', async () => {
    const seen = { audited: [] as PurgeAuditEntry[] } as { params?: RunPurgeParams; audited: PurgeAuditEntry[] }
    const result = await resolveWorktreesPurge(registryDeps, { id: REPO_ID, path: PATH }, '/audit', purgeDeps(seen, deleted))
    expect(result).toEqual(deleted)
    expect(seen.params).toMatchObject({ repoRoot: '/repo', path: PATH })
    expect(seen.audited).toHaveLength(1)
    expect(seen.audited[0]).toMatchObject({ action: 'worktree-purge', path: 'impl-29-stale', result: 'deleted', failure: null, call: ['bin/worktrees.mjs'] })
  })

  it('audits a refused outcome as refused and a channel failure as failed with its kind', async () => {
    const refusedSeen = { audited: [] as PurgeAuditEntry[] }
    await resolveWorktreesPurge(registryDeps, { id: REPO_ID, path: PATH }, '/audit', purgeDeps(refusedSeen, { ...deleted, outcome: 'refused', message: 'not an orphan' }))
    expect(refusedSeen.audited[0]).toMatchObject({ result: 'refused', failure: null })

    const failedSeen = { audited: [] as PurgeAuditEntry[] }
    await resolveWorktreesPurge(
      registryDeps,
      { id: REPO_ID, path: PATH },
      '/audit',
      purgeDeps(failedSeen, { ok: false, kind: 'timeout', message: 'slow', readAt: 't', call: ['bin/worktrees.mjs'] }),
    )
    expect(failedSeen.audited[0]).toMatchObject({ result: 'failed', failure: 'timeout' })
  })
})
