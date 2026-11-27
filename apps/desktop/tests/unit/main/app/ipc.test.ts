import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { WorktreesReport } from '@/types/reclaimer'
import { readWorktreeReport } from '@/main/features/worktrees/report'
import { callAction, createTestContext } from '../../../support/context'
import { recordingWatcher } from '../../../support/operator-rig'
import { readyEntry } from '../../../support/repo-config'

vi.mock('@/main/features/worktrees/report', () => ({ readWorktreeReport: vi.fn() }))

const REPO_ID = 'repo-1' as unknown as RepoId

const READY_ENTRY = readyEntry(
  { id: REPO_ID, displayName: 'widgets' },
  { repo: 'acme/widgets', owner: 'acme', name: 'widgets', reviewCycleCap: 3, commands: { worktrees: null, budget: null } },
)

const NOT_READY_ENTRY = {
  id: REPO_ID,
  path: '/repo',
  displayName: 'widgets',
  problem: { kind: 'directory-missing' as const },
  diagnostics: [],
}

const read = vi.mocked(readWorktreeReport)

describe('worktrees.report', () => {
  beforeEach(() => {
    read.mockReset()
  })

  it.each([undefined, ''])('rejects the id %j', async (id) => {
    await expect(callAction(createTestContext(), 'worktrees.report', { id } as never)).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
  })

  it('surfaces a registry that could not be listed', async () => {
    const ctx = createTestContext({ repos: { list: () => Promise.resolve({ ok: false, kind: 'registry-unreadable', message: 'disk on fire' }) } })
    await expect(callAction(ctx, 'worktrees.report', { id: REPO_ID })).rejects.toThrow("'worktrees:report' could not list repositories: disk on fire")
  })

  it('rejects an id with no matching repository', async () => {
    await expect(callAction(createTestContext(), 'worktrees.report', { id: REPO_ID })).rejects.toThrow(
      `'worktrees:report' found no repository registered with id '${REPO_ID}'`,
    )
  })

  it('rejects a repository that is not ready', async () => {
    const ctx = createTestContext({ repositories: [NOT_READY_ENTRY] })
    await expect(callAction(ctx, 'worktrees.report', { id: REPO_ID })).rejects.toThrow("'worktrees:report' requires a 'ready' repository, got 'directory-missing'")
  })

  it('reads the report for a ready repository, passing its resolved path, repo and integration branch through', async () => {
    const report: WorktreesReport = { ok: false, kind: 'timeout', message: 'node timed out after 60000ms', readAt: '2026-01-01T00:00:00.000Z' }
    read.mockResolvedValue(report)
    const result = await callAction(createTestContext({ repositories: [READY_ENTRY] }), 'worktrees.report', { id: REPO_ID })
    expect(result).toBe(report)
    expect(read.mock.calls[0]?.[1]).toEqual({ repoRoot: '/repo', repo: 'acme/widgets', integration: 'dev' })
  })
})

describe('board.refresh', () => {
  it('rejects an id with no matching repository', async () => {
    const ctx = createTestContext({ live: recordingWatcher().live })
    await expect(callAction(ctx, 'board.refresh', { repoId: REPO_ID })).rejects.toThrow(`'board:refresh' found no repository registered with id '${REPO_ID}'`)
  })

  it('surfaces a registry that could not be listed when repoId is present', async () => {
    const ctx = createTestContext({ repos: { list: () => Promise.resolve({ ok: false, kind: 'registry-unreadable', message: 'disk on fire' }) }, live: recordingWatcher().live })
    await expect(callAction(ctx, 'board.refresh', { repoId: REPO_ID })).rejects.toThrow("'board:refresh' could not list repositories: disk on fire")
  })

  it('forwards a registered repository to the watcher and returns its snapshot', async () => {
    const { live, refreshes } = recordingWatcher()
    const ctx = createTestContext({ repositories: [NOT_READY_ENTRY], live })
    expect(await callAction(ctx, 'board.refresh', { repoId: REPO_ID, source: 'github' })).toBe(live.watcher.snapshot())
    expect(refreshes).toEqual([{ repoId: REPO_ID, source: 'github' }])
  })

  it('an empty request forces every source', async () => {
    const { live, refreshes } = recordingWatcher()
    await callAction(createTestContext({ live }), 'board.refresh', {})
    expect(refreshes).toEqual([{}])
  })
})
