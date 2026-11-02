import { describe, expect, it } from 'vitest'
import { forcedReclaimFor } from '@/renderer/repositories/worktrees-model'
import type { InspectedWorktree } from '@/types/reclaimer'

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
