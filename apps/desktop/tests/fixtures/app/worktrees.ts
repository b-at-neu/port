// Fixture mode's canned worktrees:report — one each of active, done, dirty
// and two locked, plus one orphan directory.
import type { ForcedReclaim, InspectedWorktree, WorktreesPurgeResult, WorktreesReclaimResult, WorktreesReport } from '@/types/reclaimer'

const WORKTREES_ROOT = '/home/you/src/widgets/.claude/worktrees'
const ORPHAN_PATH = `${WORKTREES_ROOT}/impl-29-stale`

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
    otherwiseReclaimable: false,
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
      otherwiseReclaimable: true,
      producer: 'operator',
    }),
    worktree({
      path: `${WORKTREES_ROOT}/impl-51`,
      pathBasename: 'impl-51',
      branch: '51-backfill-order-totals',
      head: 'f0a1b2c',
      state: 'locked',
      reason: `locked: a review session is still attached — reclaimable once unlocked: git worktree unlock "${WORKTREES_ROOT}/impl-51"`,
      issue: 51,
      rung: 'branch-name',
      locked: true,
      lockReason: 'a review session is still attached',
      otherwiseReclaimable: true,
    }),
    worktree({
      path: `${WORKTREES_ROOT}/impl-52`,
      pathBasename: 'impl-52',
      branch: '52-export-audit-csv',
      head: 'c3d4e5f',
      state: 'locked',
      reason: 'locked: an implementation session is running',
      issue: 52,
      rung: 'branch-name',
      locked: true,
      lockReason: 'an implementation session is running',
    }),
  ]

  return {
    ok: true,
    mainRoot: '/home/you/src/widgets',
    integrationRef: 'dev',
    worktrees: worktreesList,
    orphanDirs: [ORPHAN_PATH],
    registered: worktreesList.length,
    byState: { active: 1, done: 1, dirty: 1, locked: 2 },
    githubResolution: 'resolved',
    porcelainJoin: 'joined',
    forcedActions: 'supported',
    readAt: now.toISOString(),
  }
}

// Removes the report's own done row, or, for a forced reclaim, the one row the operator confirmed.
export function fixtureWorktreesReclaim(now: Date, force: ForcedReclaim | null): WorktreesReclaimResult {
  const issue = force === null ? 36 : Number(/impl-(\d+)$/.exec(force.path)?.[1] ?? 0) || null
  const path = force?.path ?? `${WORKTREES_ROOT}/impl-36`
  const args = force === null ? ['--issue', '36'] : ['--path', path, '--max', '1', ...(force.unlock ? ['--unlock'] : []), ...(force.forceDirty ? ['--force-dirty'] : [])]
  return {
    ok: true,
    removed: 1,
    results: [{ path, pathBasename: path.slice(path.lastIndexOf('/') + 1), issue, outcome: 'removed', error: null, branchDeleted: true }],
    readAt: now.toISOString(),
    call: ['plugins/port/bin/worktrees.mjs', 'reclaim', '--json', ...args],
  }
}

// Deletes impl-29-stale, the report's own orphan directory.
export function fixtureWorktreesPurge(now: Date): WorktreesPurgeResult {
  return {
    ok: true,
    outcome: 'deleted',
    pathBasename: 'impl-29-stale',
    message: null,
    cause: null,
    readAt: now.toISOString(),
    call: ['plugins/port/bin/worktrees.mjs', 'purge', '--orphan', ORPHAN_PATH, '--json'],
  }
}
