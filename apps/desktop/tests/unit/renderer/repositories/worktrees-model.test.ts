import { describe, expect, it } from 'vitest'
import { forcedConfirm, forcedReclaimFor, purgeToast, reclaimToast } from '@/renderer/repositories/worktrees-model'
import type { InspectedWorktree, WorktreesPurgeResult, WorktreesReclaimResult } from '@/types/reclaimer'

function worktree(overrides: Partial<InspectedWorktree> = {}): InspectedWorktree {
  return {
    path: '/repo/.claude/worktrees/impl-1',
    pathBasename: 'impl-1',
    branch: '1-ticket',
    head: 'abc123',
    state: 'locked',
    reason: 'locked',
    issue: 1,
    rung: 'branch-name',
    locked: true,
    lockReason: null,
    dirtyFiles: 0,
    reclaimable: false,
    otherwiseReclaimable: true,
    prunable: null,
    producer: null,
    ...overrides,
  }
}

describe('forcedReclaimFor', () => {
  it.each([
    ['a finished clean locked worktree unlocks only', { state: 'locked', dirtyFiles: 0 }, { unlock: true, forceDirty: false }],
    ['a finished dirty locked worktree unlocks and discards', { state: 'locked', dirtyFiles: 3 }, { unlock: true, forceDirty: true }],
    ['a locked worktree with an unknown dirty count counts as dirty', { state: 'locked', dirtyFiles: -1 }, { unlock: true, forceDirty: true }],
    ['a finished dirty worktree discards only', { state: 'dirty', locked: false, dirtyFiles: 3 }, { unlock: false, forceDirty: true }],
  ] as const)('%s', (_label, overrides, expected) => {
    expect(forcedReclaimFor(worktree(overrides))).toEqual(expected)
  })

  it.each(['active', 'done', 'no-work', 'unresolved', 'outside'] as const)('offers nothing for a %s row', (state) => {
    expect(forcedReclaimFor(worktree({ state, otherwiseReclaimable: true }))).toBeNull()
  })

  it('offers nothing for a locked worktree that is still in use', () => {
    expect(forcedReclaimFor(worktree({ otherwiseReclaimable: false }))).toBeNull()
  })
})

describe('forcedConfirm', () => {
  it.each([
    ['discarding changes', { unlock: false, forceDirty: true }, 'destructive'],
    ['unlocking and discarding', { unlock: true, forceDirty: true }, 'destructive'],
    ['unlocking only', { unlock: true, forceDirty: false }, 'default'],
  ] as const)('is %s with the %s tone', (_label, flags, tone) => {
    const target = worktree()
    expect(forcedConfirm([target], { path: target.path, ...flags }).tone).toBe(tone)
  })

  it('falls back to a plain reclaim when there is no forced target', () => {
    expect(forcedConfirm([worktree()], null).tone).toBe('destructive')
  })
})

const RECLAIMED: WorktreesReclaimResult = { ok: true, removed: 1, results: [], readAt: 't', call: [] }
const RECLAIM_FAILED: WorktreesReclaimResult = { ok: false, readAt: 't', call: null, kind: 'timeout', message: '' }
const PURGED: WorktreesPurgeResult = { ok: true, outcome: 'deleted', pathBasename: 'x', message: null, cause: null, readAt: 't', call: [] }
const PURGE_FAILED: WorktreesPurgeResult = { ok: false, readAt: 't', call: null, kind: 'timeout', message: '' }

describe('result toasts', () => {
  it.each([
    ['a reclaim that ran', reclaimToast(RECLAIMED), 'success'],
    ['a reclaim that was refused', reclaimToast(RECLAIM_FAILED), 'error'],
    ['a purge that ran', purgeToast(PURGED), 'success'],
    ['a purge that was refused', purgeToast(PURGE_FAILED), 'error'],
  ] as const)('%s toasts %s', (_label, toast, tone) => {
    expect(toast.tone).toBe(tone)
  })
})
