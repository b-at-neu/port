import { describe, expect, it } from 'vitest'
import {
  failureCopy,
  needsAttentionCount,
  producerCopy,
  reclaimDialogTitle,
  reclaimFailureToast,
  reclaimNothingToReclaimTooltip,
  reclaimResultToast,
} from './worktrees-copy'
import type { InspectedWorktree, ReclaimedWorktree, WorktreesReclaimResult, WorktreesReport } from '../../../shared/reclaimer/types'

function worktree(overrides: Partial<InspectedWorktree> = {}): InspectedWorktree {
  return {
    path: '/repo/.claude/worktrees/impl-1',
    pathBasename: 'impl-1',
    branch: '1-ticket',
    head: 'abc123',
    state: 'active',
    reason: 'in progress',
    issue: 1,
    rung: 'branch-name',
    locked: false,
    lockReason: null,
    dirtyFiles: 0,
    reclaimable: false,
    prunable: null,
    producer: null,
    ...overrides,
  }
}

describe('failureCopy', () => {
  it('covers every failure kind with its own sentence', () => {
    const cases: ReadonlyArray<Extract<WorktreesReport, { ok: false }>> = [
      { ok: false, kind: 'not-configured', message: '', readAt: '' },
      { ok: false, kind: 'unsupported-runner', token: 'python', message: '', readAt: '' },
      { ok: false, kind: 'unparseable-command', message: '', readAt: '' },
      { ok: false, kind: 'not-found', message: '', readAt: '' },
      { ok: false, kind: 'cwd-missing', message: '', readAt: '' },
      { ok: false, kind: 'script-failed', message: 'boom', readAt: '' },
      { ok: false, kind: 'report-unparseable', message: '', readAt: '' },
      { ok: false, kind: 'timeout', message: '', readAt: '' },
      { ok: false, kind: 'signalled', message: '', readAt: '' },
      { ok: false, kind: 'output-too-large', message: '', readAt: '' },
      { ok: false, kind: 'nonzero', message: 'exit 1', readAt: '' },
      { ok: false, kind: 'spawn-failed', message: 'ENOENT', readAt: '' },
    ]
    for (const failure of cases) {
      expect(failureCopy(failure).length).toBeGreaterThan(0)
    }
    expect(failureCopy(cases[1] as Extract<WorktreesReport, { ok: false; kind: 'unsupported-runner' }>)).toContain('python')
    expect(failureCopy(cases[5] as Extract<WorktreesReport, { ok: false; kind: 'script-failed' }>)).toContain('boom')
  })
})

describe('producerCopy', () => {
  it('names operator and dispatched, null otherwise', () => {
    expect(producerCopy('operator')).toBe('operator session')
    expect(producerCopy('dispatched')).toBe('dispatched agent')
    expect(producerCopy(null)).toBeNull()
  })
})

describe('needsAttentionCount', () => {
  it('counts only non-reclaimable locked/dirty/unresolved worktrees', () => {
    const worktrees = [
      worktree({ state: 'locked', reclaimable: false }),
      worktree({ state: 'dirty', reclaimable: false }),
      worktree({ state: 'unresolved', reclaimable: false }),
      worktree({ state: 'locked', reclaimable: true }),
      worktree({ state: 'active', reclaimable: false }),
      worktree({ state: 'done', reclaimable: true }),
    ]
    expect(needsAttentionCount(worktrees)).toBe(3)
  })

  it('zero for an empty list', () => {
    expect(needsAttentionCount([])).toBe(0)
  })
})

function reclaimed(overrides: Partial<ReclaimedWorktree> = {}): ReclaimedWorktree {
  return { path: '/repo/.claude/worktrees/impl-36', pathBasename: 'impl-36', issue: 36, outcome: 'removed', error: null, branchDeleted: true, ...overrides }
}

describe('reclaimDialogTitle', () => {
  it('names a single worktree by path when reclaiming one', () => {
    expect(reclaimDialogTitle(1, 'impl-36')).toBe('Reclaim impl-36?')
  })

  it('counts worktrees otherwise', () => {
    expect(reclaimDialogTitle(2, null)).toBe('Reclaim 2 worktrees?')
  })
})

describe('reclaimResultToast', () => {
  it('reports a full success', () => {
    const result: Extract<WorktreesReclaimResult, { ok: true }> = { ok: true, removed: 2, results: [reclaimed(), reclaimed({ path: '/x', pathBasename: 'impl-50', issue: 50 })], readAt: 't' }
    expect(reclaimResultToast(result)).toBe('Reclaimed 2 worktrees.')
  })

  it('reports a partial success with the failed entries', () => {
    const result: Extract<WorktreesReclaimResult, { ok: true }> = {
      ok: true,
      removed: 1,
      results: [reclaimed(), reclaimed({ path: '/x', pathBasename: 'impl-50', issue: 50, outcome: 'failed', error: 'locked', branchDeleted: null })],
      readAt: 't',
    }
    expect(reclaimResultToast(result)).toBe('Reclaimed 1 of 2. impl-50: locked')
  })
})

describe('reclaimFailureToast / reclaimNothingToReclaimTooltip', () => {
  it('reuses failureCopy for a failed reclaim', () => {
    expect(reclaimFailureToast({ ok: false, kind: 'script-failed', message: 'boom', readAt: 't' })).toContain('boom')
  })

  it('names why reclaim is disabled', () => {
    expect(reclaimNothingToReclaimTooltip().length).toBeGreaterThan(0)
  })
})
