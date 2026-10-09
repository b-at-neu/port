import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../shared/repos'
import type { ReposListResponse } from '../../shared/ipc'
import { resolveVocabulary } from '../../shared/labels/vocabulary'
import type { ReclaimedWorktree } from '../../shared/reclaimer/types'
import type { WorktreesReclaimResult } from '../../shared/reclaimer/types'
import type { ReclaimAuditEntry } from '../../shared/writes/types'
import { resolveWorktreesReclaim } from './worktrees'
import type { WorktreesReclaimDeps } from './worktrees'
import type { RegistryDeps } from '../registry'

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
    await expect(resolveWorktreesReclaim(registryDeps, { id: undefined as unknown as RepoId, issue: null }, '/audit', depsWith({}))).rejects.toThrow(
      "'worktrees:reclaim' requires a non-empty 'repoId'",
    )
  })

  it('rejects a negative issue', async () => {
    await expect(resolveWorktreesReclaim(registryDeps, { id: REPO_ID, issue: -1 }, '/audit', depsWith({}))).rejects.toThrow(
      "'worktrees:reclaim' requires 'issue' to be null or a positive integer",
    )
  })

  it('rejects a repository that is not ready', async () => {
    const deps = depsWith({
      listRepositories: () =>
        Promise.resolve({ ok: true, repositories: [{ id: REPO_ID, path: '/repo', displayName: 'widgets', problem: { kind: 'directory-missing' as const }, diagnostics: [] }] }),
    })
    await expect(resolveWorktreesReclaim(registryDeps, { id: REPO_ID, issue: null }, '/audit', deps)).rejects.toThrow(
      "'worktrees:reclaim' requires a 'ready' repository, got 'directory-missing'",
    )
  })

  it('appends one applied audit entry on a full success', async () => {
    let auditedEntry: ReclaimAuditEntry | undefined
    const deps = depsWith({
      listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }),
      runReclaim: () => Promise.resolve({ ok: true, removed: 1, results: [reclaimed()], readAt: 't' } satisfies WorktreesReclaimResult),
      appendAudit: (_dir, entry) => {
        auditedEntry = entry as ReclaimAuditEntry
        return Promise.resolve({ ok: true })
      },
    })
    const result = await resolveWorktreesReclaim(registryDeps, { id: REPO_ID, issue: null }, '/audit', deps)
    expect(result.ok).toBe(true)
    expect(auditedEntry).toMatchObject({ action: 'worktree-reclaim', removed: ['impl-36'], failed: [], result: 'applied', failure: null })
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
        } satisfies WorktreesReclaimResult),
      appendAudit: (_dir, entry) => {
        auditedEntry = entry as ReclaimAuditEntry
        return Promise.resolve({ ok: true })
      },
    })
    const result = await resolveWorktreesReclaim(registryDeps, { id: REPO_ID, issue: 36 }, '/audit', deps)
    expect(result.ok).toBe(true)
    expect(auditedEntry).toMatchObject({ issue: 36, removed: [], failed: ['impl-36'], result: 'partial' })
  })

  it('appends a failed audit entry when the reclaim itself failed, aborts included', async () => {
    let auditedEntry: ReclaimAuditEntry | undefined
    const deps = depsWith({
      listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }),
      runReclaim: () => Promise.resolve({ ok: false, kind: 'script-failed', message: 'boom', readAt: 't' } satisfies WorktreesReclaimResult),
      appendAudit: (_dir, entry) => {
        auditedEntry = entry as ReclaimAuditEntry
        return Promise.resolve({ ok: true })
      },
    })
    const result = await resolveWorktreesReclaim(registryDeps, { id: REPO_ID, issue: null }, '/audit', deps)
    expect(result.ok).toBe(false)
    expect(auditedEntry).toMatchObject({ result: 'failed', failure: 'script-failed' })
  })

  it('an audit append failure never changes the already-computed result', async () => {
    const deps = depsWith({
      listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }),
      runReclaim: () => Promise.resolve({ ok: true, removed: 1, results: [reclaimed()], readAt: 't' } satisfies WorktreesReclaimResult),
      appendAudit: () => Promise.resolve({ ok: false, message: 'disk on fire' }),
    })
    const result = await resolveWorktreesReclaim(registryDeps, { id: REPO_ID, issue: null }, '/audit', deps)
    expect(result).toEqual({ ok: true, removed: 1, results: [reclaimed()], readAt: 't' })
  })
})
