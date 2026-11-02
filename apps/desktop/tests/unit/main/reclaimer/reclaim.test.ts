import { describe, expect, it } from 'vitest'
import { createFakeGithub, createFakeRepo, MAIN, WORKTREES } from '../../../fixtures/reclaimer-harness'
import type { FakeGithubOptions, FakeRepoOptions, FakeWorktree } from '../../../fixtures/reclaimer-harness'
import { runReclaim } from '@/main/reclaimer/reclaim'
import type { ForcedReclaim, WorktreesReclaimResult } from '@/types/reclaimer'

const path = (n: number): string => `${WORKTREES}/impl-${String(n)}`
const finished = (n: number, overrides: Partial<FakeWorktree> = {}): FakeWorktree => ({ path: path(n), branch: `${String(n)}-ticket`, ...overrides })

async function reclaim(repoOptions: FakeRepoOptions, ghOptions: FakeGithubOptions, scope: { issue?: number | null; force?: ForcedReclaim | null } = {}) {
  const repo = createFakeRepo(repoOptions)
  const gh = createFakeGithub(ghOptions)
  const result = await runReclaim({ repoRoot: MAIN, repo: 'acme/widgets', integration: 'dev', github: gh.github, ...repo.seams, issue: scope.issue ?? null, force: scope.force ?? null })
  return { result, repo }
}

function ok(result: WorktreesReclaimResult): Extract<WorktreesReclaimResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got ${result.kind}`)
  return result
}

const removals = (calls: readonly string[][]): string[] => calls.filter((c) => c[0] === 'worktree' && c[1] === 'remove').map((c) => c[3] ?? '')

describe('runReclaim — every reclaimable worktree', () => {
  it('removes a merged worktree, deletes its merged branch and prunes once', async () => {
    const { result, repo } = await reclaim({ worktrees: [finished(36), finished(41)] }, { states: { 36: 'MERGED', 41: 'OPEN' } })
    const value = ok(result)
    expect(value).toMatchObject({ removed: 1, call: ['reclaim'] })
    expect(value.results.map((r) => [r.pathBasename, r.outcome, r.error, r.branchDeleted, r.issue])).toEqual([
      ['impl-36', 'removed', null, true, 36],
      ['impl-41', 'kept', null, null, 41],
    ])
    expect(removals(repo.calls)).toEqual([path(36)])
    expect(repo.branchesDeleted).toEqual(['36-ticket'])
    expect(repo.calls.filter((c) => c[0] === 'worktree' && c[1] === 'prune')).toHaveLength(1)
    expect(repo.nodes.has(path(36))).toBe(false)
  })

  it('keeps an unmerged branch and says so', async () => {
    const { result } = await reclaim({ worktrees: [finished(36)], unmergedBranches: ['36-ticket'] }, { states: { 36: 'MERGED' } })
    expect(ok(result).results[0]).toMatchObject({ outcome: 'removed', branchDeleted: false })
  })

  it('never deletes a detached worktree’s branch', async () => {
    const { result, repo } = await reclaim({ worktrees: [{ path: path(36), branch: null, subject: '#36 done' }] }, { states: { 36: 'CLOSED' } })
    expect(ok(result).results[0]).toMatchObject({ outcome: 'removed', branchDeleted: null })
    expect(repo.branchesDeleted).toEqual([])
  })

  it('removes at most five, oldest first', async () => {
    const worktrees = [1, 2, 3, 4, 5, 6].map((n) => finished(n, { modifiedAt: `2026-01-0${String(7 - n)}T00:00:00.000Z` }))
    const states = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [n, 'MERGED' as const]))
    const { result, repo } = await reclaim({ worktrees }, { states })
    expect(removals(repo.calls)).toEqual([path(6), path(5), path(4), path(3), path(2)])
    expect(ok(result).removed).toBe(5)
    expect(ok(result).results.find((r) => r.issue === 1)?.outcome).toBe('kept')
  })

  it('keeps a locked or dirty worktree, since neither flag is set', async () => {
    const { result, repo } = await reclaim(
      { worktrees: [finished(36, { locked: true }), finished(37, { status: [' M a.ts'] })] },
      { states: { 36: 'MERGED', 37: 'MERGED' } },
    )
    expect(ok(result).removed).toBe(0)
    expect(removals(repo.calls)).toEqual([])
  })

  it('removes nothing when GitHub cannot be read', async () => {
    const { result, repo } = await reclaim({ worktrees: [finished(36)] }, { failure: { ok: false, kind: 'network', stdout: '', stderr: 'offline' } })
    expect(result).toMatchObject({ ok: false, kind: 'github-unavailable', call: ['reclaim'] })
    expect(removals(repo.calls)).toEqual([])
    expect(repo.calls.some((c) => c[1] === 'prune')).toBe(false)
  })

  it('fails with the git kind when the repository cannot be read', async () => {
    const repo = createFakeRepo()
    const result = await runReclaim({
      repoRoot: MAIN,
      repo: 'acme/widgets',
      integration: 'dev',
      ...repo.seams,
      git: () => Promise.resolve({ ok: false, kind: 'cwd-missing', cwd: MAIN }),
      issue: null,
      force: null,
    })
    expect(result).toMatchObject({ ok: false, kind: 'cwd-missing', call: ['reclaim'] })
  })

})

describe('runReclaim — one issue', () => {
  it('scopes the run to that ticket’s own worktree', async () => {
    const { result, repo } = await reclaim({ worktrees: [finished(36), finished(37)] }, { states: { 36: 'MERGED', 37: 'MERGED' } }, { issue: 37 })
    expect(removals(repo.calls)).toEqual([path(37)])
    expect(ok(result).call).toEqual(['reclaim', '--issue', '37'])
  })
})

describe('runReclaim — one forced path', () => {
  const unlock: ForcedReclaim = { path: path(36), unlock: true, forceDirty: false }

  it('refuses a path that is not registered and touches nothing', async () => {
    const { result, repo } = await reclaim({ worktrees: [finished(36)] }, { states: { 36: 'MERGED' } }, { force: { path: path(99), unlock: true, forceDirty: false } })
    expect(result).toMatchObject({ ok: false, kind: 'path-not-registered', call: null })
    expect(removals(repo.calls)).toEqual([])
    expect(repo.calls.some((c) => c[1] === 'prune')).toBe(false)
  })

  it('unlocks a finished locked worktree, then removes only it', async () => {
    const { result, repo } = await reclaim({ worktrees: [finished(36, { locked: true }), finished(37)] }, { states: { 36: 'MERGED', 37: 'MERGED' } }, { force: unlock })
    expect(ok(result)).toMatchObject({ removed: 1, call: ['reclaim', '--path', path(36), '--max', '1', '--unlock'] })
    expect(repo.calls.filter((c) => c[1] === 'unlock')).toEqual([['worktree', 'unlock', path(36)]])
    expect(removals(repo.calls)).toEqual([path(36)])
    expect(ok(result).results.find((r) => r.issue === 37)?.outcome).toBe('kept')
  })

  it('reports an unlock that failed and removes nothing', async () => {
    const { result, repo } = await reclaim({ worktrees: [finished(36, { locked: true })], unlockFails: [path(36)] }, { states: { 36: 'MERGED' } }, { force: unlock })
    expect(ok(result).removed).toBe(0)
    expect(ok(result).results[0]).toMatchObject({ outcome: 'failed', error: 'unlock failed: fatal: not locked' })
    expect(removals(repo.calls)).toEqual([])
  })

  it('never unlocks a locked worktree whose item is still open', async () => {
    const { result, repo } = await reclaim({ worktrees: [finished(36, { locked: true })] }, { states: { 36: 'OPEN' } }, { force: unlock })
    expect(ok(result).removed).toBe(0)
    expect(repo.calls.some((c) => c[1] === 'unlock')).toBe(false)
  })

  it('discards a dirty worktree only when told to', async () => {
    const dirty = { worktrees: [finished(36, { status: [' M a.ts'] })] }
    const plain = await reclaim(dirty, { states: { 36: 'MERGED' } }, { force: { path: path(36), unlock: false, forceDirty: false } })
    expect(ok(plain.result).removed).toBe(0)

    const forced = await reclaim(dirty, { states: { 36: 'MERGED' } }, { force: { path: path(36), unlock: false, forceDirty: true } })
    expect(ok(forced.result)).toMatchObject({ removed: 1, call: ['reclaim', '--path', path(36), '--max', '1', '--force-dirty'] })
  })
})

describe('runReclaim — the removal itself', () => {
  it('falls back to the filesystem when git leaves the directory behind', async () => {
    const { result, repo } = await reclaim({ worktrees: [finished(36)], removeLeavesDir: [path(36)] }, { states: { 36: 'MERGED' } })
    expect(ok(result).removed).toBe(1)
    expect(repo.nodes.has(path(36))).toBe(false)
  })

  it('falls back to the filesystem when git refuses and HEAD has not moved', async () => {
    const { result, repo } = await reclaim({ worktrees: [finished(36)], removeFails: [path(36)] }, { states: { 36: 'MERGED' } })
    expect(ok(result).removed).toBe(1)
    expect(repo.nodes.has(path(36))).toBe(false)
  })

  it('reports a file still in use as a failure, keeping the branch', async () => {
    const { result, repo } = await reclaim({ worktrees: [finished(36)], removeLeavesDir: [path(36)], fsRemoveFails: { [path(36)]: 'EBUSY' } }, { states: { 36: 'MERGED' } })
    expect(ok(result).removed).toBe(0)
    expect(ok(result).results[0]).toMatchObject({ outcome: 'failed', branchDeleted: null })
    expect(ok(result).results[0]?.error).toContain('EBUSY')
    expect(repo.branchesDeleted).toEqual([])
  })

  it('keeps the directory when the worktree list cannot be re-read after removal', async () => {
    const { result, repo } = await reclaim({ worktrees: [finished(36)], removeLeavesDir: [path(36)], listBreaksAfterRemove: true }, { states: { 36: 'MERGED' } })
    expect(ok(result).results[0]).toMatchObject({ outcome: 'failed', error: "couldn't re-read the worktree list after removal; not deleted." })
    expect(repo.nodes.has(path(36))).toBe(true)
  })

  it('treats a vanished directory as removed even when the re-read fails', async () => {
    const { result } = await reclaim({ worktrees: [finished(36)], listBreaksAfterRemove: true }, { states: { 36: 'MERGED' } })
    expect(ok(result).removed).toBe(1)
  })
})
