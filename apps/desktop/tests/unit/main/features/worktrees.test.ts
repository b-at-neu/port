import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoId, RepositoryEntry } from '@/utils/repos'
import type { ReclaimedWorktree, WorktreesPurgeResult, WorktreesReclaimResult } from '@/types/reclaimer'
import type { PurgeAuditEntry, ReclaimAuditEntry } from '@/types/writes'
import { appendAudit } from '@/main/github/writes/audit'
import { runPurge } from '@/main/features/worktrees/purge'
import { runReclaim } from '@/main/features/worktrees/reclaim'
import { callAction, createTestContext } from '../../../support/context'
import { readyEntry } from '../../../support/repo-config'

vi.mock('@/main/features/worktrees/reclaim', () => ({ runReclaim: vi.fn() }))
vi.mock('@/main/features/worktrees/purge', () => ({ runPurge: vi.fn() }))
vi.mock('@/main/github/writes/audit', () => ({ appendAudit: vi.fn() }))

const REPO_ID = 'repo-1' as unknown as RepoId
const READY_ENTRY = readyEntry({ id: REPO_ID, path: '/repo' }, { repo: 'acme/widgets', owner: 'acme', name: 'widgets' })

const reclaim = vi.mocked(runReclaim)
const purge = vi.mocked(runPurge)
const audit = vi.mocked(appendAudit)

const ctxWith = (repositories: readonly RepositoryEntry[] = [READY_ENTRY]) => createTestContext({ repositories })

function reclaimed(overrides: Partial<ReclaimedWorktree> = {}): ReclaimedWorktree {
  return { path: '/repo/.claude/worktrees/impl-36', pathBasename: 'impl-36', issue: 36, outcome: 'removed', error: null, branchDeleted: true, ...overrides }
}

const applied: WorktreesReclaimResult = { ok: true, removed: 1, results: [reclaimed()], readAt: 't', call: ['reclaim'] }
const auditedEntry = <T>(): T => audit.mock.calls[0]?.[1] as T

beforeEach(() => {
  reclaim.mockReset()
  purge.mockReset()
  audit.mockReset()
  audit.mockResolvedValue({ ok: true })
})

describe('worktrees.reclaim', () => {
  it('rejects a repository that is not ready', async () => {
    const ctx = ctxWith([{ id: REPO_ID, path: '/repo', displayName: 'widgets', problem: { kind: 'directory-missing' as const }, diagnostics: [] }])
    await expect(callAction(ctx, 'worktrees.reclaim', { id: REPO_ID, issue: null, force: null })).rejects.toThrow("'worktrees:reclaim' requires a 'ready' repository, got 'directory-missing'")
  })

  it('appends one applied audit entry on a full success', async () => {
    reclaim.mockResolvedValue(applied)
    const result = await callAction(ctxWith(), 'worktrees.reclaim', { id: REPO_ID, issue: null, force: null })
    expect(result.ok).toBe(true)
    expect(audit).toHaveBeenCalledTimes(1)
    expect(auditedEntry<ReclaimAuditEntry>()).toMatchObject({ action: 'worktree-reclaim', removed: ['impl-36'], failed: [], result: 'applied', failure: null, call: ['reclaim'] })
  })

  it('appends a partial-result audit entry when some candidates failed', async () => {
    reclaim.mockResolvedValue({ ok: true, removed: 0, results: [reclaimed({ outcome: 'failed', error: 'locked', branchDeleted: null })], readAt: 't', call: ['reclaim'] })
    const result = await callAction(ctxWith(), 'worktrees.reclaim', { id: REPO_ID, issue: 36, force: null })
    expect(result.ok).toBe(true)
    expect(auditedEntry<ReclaimAuditEntry>()).toMatchObject({ issue: 36, removed: [], failed: ['impl-36'], result: 'partial' })
  })

  it('appends a failed audit entry when the reclaim itself failed, aborts included', async () => {
    reclaim.mockResolvedValue({ ok: false, kind: 'github-unavailable', message: 'boom', readAt: 't', call: ['reclaim'] })
    const result = await callAction(ctxWith(), 'worktrees.reclaim', { id: REPO_ID, issue: null, force: null })
    expect(result.ok).toBe(false)
    expect(auditedEntry<ReclaimAuditEntry>()).toMatchObject({ result: 'failed', failure: 'github-unavailable', call: ['reclaim'] })
  })

  it('an audit append failure never changes the already-computed result', async () => {
    reclaim.mockResolvedValue(applied)
    audit.mockResolvedValue({ ok: false, message: 'disk on fire' })
    expect(await callAction(ctxWith(), 'worktrees.reclaim', { id: REPO_ID, issue: null, force: null })).toEqual(applied)
  })

  describe('force', () => {
    const FORCE = { path: '/repo/.claude/worktrees/impl-51', unlock: true, forceDirty: false }

    it.each([
      ['no flag set', { id: REPO_ID, issue: null, force: { ...FORCE, unlock: false } }],
      ['a non-boolean flag', { id: REPO_ID, issue: null, force: { ...FORCE, forceDirty: 'yes' } }],
      ['an empty path', { id: REPO_ID, issue: null, force: { ...FORCE, path: '' } }],
      ['an issue alongside', { id: REPO_ID, issue: 51, force: FORCE }],
      ['a negative issue', { id: REPO_ID, issue: -1, force: null }],
    ])('rejects %s before anything runs', async (_label, request) => {
      await expect(callAction(ctxWith(), 'worktrees.reclaim', request as never)).rejects.toThrow()
      expect(reclaim).not.toHaveBeenCalled()
    })

    it.each([
      ['a path outside the repository', '/elsewhere/impl-51'],
      ['the repository root itself', '/repo'],
    ])('rejects %s before anything runs', async (_label, path) => {
      await expect(callAction(ctxWith(), 'worktrees.reclaim', { id: REPO_ID, issue: null, force: { ...FORCE, path } })).rejects.toThrow("'force.path' to be inside the repository")
      expect(reclaim).not.toHaveBeenCalled()
    })

    it('passes the confirmed force to the run and audits its flags', async () => {
      reclaim.mockResolvedValue(applied)
      await callAction(ctxWith(), 'worktrees.reclaim', { id: REPO_ID, issue: null, force: FORCE })
      expect(reclaim.mock.calls[0]?.[1]).toMatchObject({ repoRoot: '/repo', repo: 'acme/widgets', integration: 'dev', force: FORCE })
      expect(auditedEntry<ReclaimAuditEntry>()).toMatchObject({ force: { unlock: true, forceDirty: false } })
    })

    it('audits a plain reclaim with no force', async () => {
      reclaim.mockResolvedValue(applied)
      await callAction(ctxWith(), 'worktrees.reclaim', { id: REPO_ID, issue: null, force: null })
      expect(auditedEntry<ReclaimAuditEntry>()).toMatchObject({ force: null })
    })
  })
})

describe('worktrees.purge', () => {
  const PATH = '/repo/.claude/worktrees/impl-29-stale'
  const deleted: WorktreesPurgeResult = { ok: true, outcome: 'deleted', pathBasename: 'impl-29-stale', message: null, cause: null, readAt: 't', call: ['purge', '--orphan', PATH] }

  it.each([
    ['an empty path', ''],
    ['a path outside the repository', '/elsewhere/impl-29-stale'],
  ])('rejects %s before anything runs', async (_label, path) => {
    await expect(callAction(ctxWith(), 'worktrees.purge', { id: REPO_ID, path })).rejects.toThrow()
    expect(purge).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  it('runs the purge for the one path and audits its basename once', async () => {
    purge.mockResolvedValue(deleted)
    expect(await callAction(ctxWith(), 'worktrees.purge', { id: REPO_ID, path: PATH })).toEqual(deleted)
    expect(purge.mock.calls[0]?.[1]).toMatchObject({ repoRoot: '/repo', path: PATH })
    expect(audit).toHaveBeenCalledTimes(1)
    expect(auditedEntry<PurgeAuditEntry>()).toMatchObject({ action: 'worktree-purge', path: 'impl-29-stale', result: 'deleted', failure: null, call: ['purge', '--orphan', PATH] })
  })

  it('audits a refused outcome as refused and a channel failure as failed with its kind', async () => {
    purge.mockResolvedValue({ ...deleted, outcome: 'refused', message: 'not an orphan' })
    await callAction(ctxWith(), 'worktrees.purge', { id: REPO_ID, path: PATH })
    expect(auditedEntry<PurgeAuditEntry>()).toMatchObject({ result: 'refused', failure: null })

    audit.mockClear()
    purge.mockResolvedValue({ ok: false, kind: 'timeout', message: 'slow', readAt: 't', call: ['purge', '--orphan', PATH] })
    await callAction(ctxWith(), 'worktrees.purge', { id: REPO_ID, path: PATH })
    expect(auditedEntry<PurgeAuditEntry>()).toMatchObject({ result: 'failed', failure: 'timeout' })
  })
})
