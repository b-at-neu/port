import { describe, expect, it } from 'vitest'
import {
  failureCopy,
  forcedActionLabel,
  forcedConfirmLabel,
  forcedDialogBody,
  forcedDialogIsDestructive,
  forcedDialogTitle,
  forcedReclaimToast,
  needsAttentionCount,
  producerCopy,
  purgeResultToast,
  reclaimDialogTitle,
  reclaimFailureToast,
  reclaimNothingToReclaimTooltip,
  reclaimResultToast,
} from '@/renderer/repositories/worktrees-copy'
import type { InspectedWorktree, ReclaimedWorktree, WorktreesPurgeResult, WorktreesReclaimResult, WorktreesReport } from '@/types/reclaimer'

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
    otherwiseReclaimable: false,
    prunable: null,
    producer: null,
    ...overrides,
  }
}

describe('failureCopy', () => {
  it('interpolates the runner token and the script message', () => {
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
    const result: Extract<WorktreesReclaimResult, { ok: true }> = {
      ok: true,
      removed: 2,
      results: [reclaimed(), reclaimed({ path: '/x', pathBasename: 'impl-50', issue: 50 })],
      readAt: 't',
      call: ['bin/worktrees.mjs'],
    }
    expect(reclaimResultToast(result)).toBe('Reclaimed 2 worktrees.')
  })

  it('reports a partial success with the failed entries', () => {
    const result: Extract<WorktreesReclaimResult, { ok: true }> = {
      ok: true,
      removed: 1,
      results: [reclaimed(), reclaimed({ path: '/x', pathBasename: 'impl-50', issue: 50, outcome: 'failed', error: 'locked', branchDeleted: null })],
      readAt: 't',
      call: ['bin/worktrees.mjs'],
    }
    expect(reclaimResultToast(result)).toBe('Reclaimed 1 of 2. impl-50: locked')
  })
})

describe('reclaimFailureToast / reclaimNothingToReclaimTooltip', () => {
  it('reuses failureCopy for a failed reclaim', () => {
    expect(reclaimFailureToast({ ok: false, kind: 'script-failed', message: 'boom', readAt: 't', call: ['bin/worktrees.mjs'] })).toContain('boom')
  })

  it('names why reclaim is disabled', () => {
    expect(reclaimNothingToReclaimTooltip().length).toBeGreaterThan(0)
  })
})

describe('forced reclaim copy', () => {
  const clean = { unlock: true, forceDirty: false }
  const unlockAndDiscard = { unlock: true, forceDirty: true }
  const discard = { unlock: false, forceDirty: true }

  it('names the action by what it does', () => {
    expect(forcedActionLabel(clean)).toBe('Unlock and reclaim')
    expect(forcedActionLabel(unlockAndDiscard)).toBe('Unlock and discard changes')
    expect(forcedActionLabel(discard)).toBe('Discard changes and reclaim')
    expect(forcedConfirmLabel(clean)).toBe('Unlock and reclaim')
    expect(forcedConfirmLabel(unlockAndDiscard)).toBe('Unlock and discard')
    expect(forcedConfirmLabel(discard)).toBe('Discard and reclaim')
  })

  it('titles a dialog with the file count, or without one when it is unknown', () => {
    expect(forcedDialogTitle('impl-51', clean, 0)).toBe('Unlock and reclaim impl-51?')
    expect(forcedDialogTitle('impl-51', unlockAndDiscard, 3)).toBe('Unlock impl-51 and discard its changes?')
    expect(forcedDialogTitle('impl-50', discard, 3)).toBe('Discard 3 uncommitted files in impl-50?')
    expect(forcedDialogTitle('impl-50', discard, 1)).toBe('Discard 1 uncommitted file in impl-50?')
    expect(forcedDialogTitle('impl-50', discard, -1)).toBe('Discard uncommitted changes in impl-50?')
  })

  it('warns that discarded changes cannot be recovered, and says so only when they are discarded', () => {
    expect(forcedDialogBody('impl-51', unlockAndDiscard, 3)).toContain('3 uncommitted files')
    expect(forcedDialogBody('impl-51', unlockAndDiscard, -1)).toContain('port couldn’t count them')
    expect(forcedDialogBody('impl-50', discard, 3)).toContain('can’t be recovered')
    expect(forcedDialogBody('impl-51', clean, 0)).not.toContain('can’t be recovered')
  })

  it('is destructive exactly when changes are discarded', () => {
    expect(forcedDialogIsDestructive(clean)).toBe(false)
    expect(forcedDialogIsDestructive(unlockAndDiscard)).toBe(true)
    expect(forcedDialogIsDestructive(discard)).toBe(true)
  })

  it('toasts removed, nothing removed, and the target’s own failure', () => {
    const base = { ok: true, readAt: 't', call: ['bin/worktrees.mjs'] } as const
    expect(forcedReclaimToast('impl-51', { ...base, removed: 1, results: [reclaimed({ pathBasename: 'impl-51' })] })).toBe('Reclaimed impl-51.')
    expect(forcedReclaimToast('impl-51', { ...base, removed: 0, results: [reclaimed({ outcome: 'kept' })] })).toBe(
      'Nothing was reclaimed. impl-51 changed since it was checked; its row shows why.',
    )
    expect(forcedReclaimToast('impl-51', { ...base, removed: 0, results: [reclaimed({ outcome: 'failed', error: 'unlock failed' })] })).toBe('Couldn’t reclaim impl-51: unlock failed.')
  })
})

describe('purgeResultToast', () => {
  const base = { ok: true, pathBasename: 'impl-29-stale', readAt: 't', call: ['bin/worktrees.mjs'] } as const
  const result = (overrides: Partial<Extract<WorktreesPurgeResult, { ok: true }>>): Extract<WorktreesPurgeResult, { ok: true }> => ({
    ...base,
    outcome: 'deleted',
    message: null,
    cause: null,
    ...overrides,
  })

  it('names each outcome', () => {
    expect(purgeResultToast(result({}))).toBe('Deleted impl-29-stale.')
    expect(purgeResultToast(result({ outcome: 'refused', message: 'x' }))).toBe('Didn’t delete impl-29-stale. It’s no longer an untracked directory.')
    expect(purgeResultToast(result({ outcome: 'failed', cause: 'file-in-use', message: 'EBUSY' }))).toContain('a file under it is still open')
    expect(purgeResultToast(result({ outcome: 'failed', cause: 'unknown', message: 'EIO' }))).toBe('Couldn’t delete impl-29-stale: EIO.')
  })
})
