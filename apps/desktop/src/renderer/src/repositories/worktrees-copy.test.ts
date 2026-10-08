import { describe, expect, it } from 'vitest'
import { failureCopy, needsAttentionCount, producerCopy } from './worktrees-copy'
import type { InspectedWorktree, WorktreesReport } from '../../../shared/reclaimer/types'

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
