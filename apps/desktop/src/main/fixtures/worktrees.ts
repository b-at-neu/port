// Fixture mode's canned worktrees:report — one each of active, done, dirty
// and locked, plus one orphan directory.
import type { InspectedWorktree, WorktreesReclaimResult, WorktreesReport } from '../../shared/reclaimer/types'

function worktree(overrides: Partial<InspectedWorktree> & Pick<InspectedWorktree, 'path' | 'pathBasename' | 'state' | 'reason'>): InspectedWorktree {
  return {
    branch: null,
    head: null,
    issue: null,
    rung: null,
    locked: false,
    lockReason: null,
    dirtyFiles: 0,
    reclaimable: false,
    prunable: null,
    producer: null,
    ...overrides,
  }
}

export function fixtureWorktreesReport(now: Date): WorktreesReport {
  const worktreesList: readonly InspectedWorktree[] = [
    worktree({
      path: '/home/you/src/widgets/.claude/worktrees/impl-41',
      pathBasename: 'impl-41',
      branch: '41-csv-export',
      head: 'a1b2c3d',
      state: 'active',
      reason: 'In progress — impl-agent is still running.',
      issue: 41,
      rung: 'branch-name',
      producer: 'dispatched',
    }),
    worktree({
      path: '/home/you/src/widgets/.claude/worktrees/impl-36',
      pathBasename: 'impl-36',
      branch: '36-paginate-audit-log',
      head: 'd4e5f6a',
      state: 'done',
      reason: 'Merged into dev — safe to reclaim.',
      issue: 36,
      rung: 'upstream-branch',
      reclaimable: true,
      prunable: false,
      producer: 'dispatched',
    }),
    worktree({
      path: '/home/you/src/widgets/.claude/worktrees/impl-50',
      pathBasename: 'impl-50',
      branch: '50-rotate-webhook-secret',
      head: 'b7c8d9e',
      state: 'dirty',
      reason: 'Uncommitted changes — 3 files modified.',
      issue: 50,
      rung: 'branch-name',
      dirtyFiles: 3,
      producer: 'operator',
    }),
    worktree({
      path: '/home/you/src/widgets/.claude/worktrees/impl-51',
      pathBasename: 'impl-51',
      branch: '51-backfill-order-totals',
      head: 'f0a1b2c',
      state: 'locked',
      reason: 'Locked: a review session is still attached.',
      issue: 51,
      rung: 'branch-name',
      locked: true,
      lockReason: 'a review session is still attached',
    }),
  ]

  return {
    ok: true,
    mainRoot: '/home/you/src/widgets',
    integrationRef: 'dev',
    worktrees: worktreesList,
    orphanDirs: ['/home/you/src/widgets/.claude/worktrees/impl-29-stale'],
    registered: worktreesList.length,
    byState: { active: 1, done: 1, dirty: 1, locked: 1 },
    githubResolution: 'resolved',
    porcelainJoin: 'joined',
    readAt: now.toISOString(),
  }
}

// Removes impl-36, the report's own done row.
export function fixtureWorktreesReclaim(now: Date): WorktreesReclaimResult {
  return {
    ok: true,
    removed: 1,
    results: [{ path: '/home/you/src/widgets/.claude/worktrees/impl-36', pathBasename: 'impl-36', issue: 36, outcome: 'removed', error: null, branchDeleted: true }],
    readAt: now.toISOString(),
  }
}
