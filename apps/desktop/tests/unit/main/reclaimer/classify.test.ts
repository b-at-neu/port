// The same case table `desktop-reclaimer` runs against `bin/worktrees.mjs`, so the two classifiers cannot silently disagree.
import { describe, expect, it } from 'vitest'
import { classifyCandidate, classifyRemovalFailure, describeReason, fallbackDecision, orphanVerdict } from '@/main/reclaimer/classify'
import type { ClassifyInput, FallbackInput, ReasonInput } from '@/main/reclaimer/classify'
import type { OrphanInput } from '@/types/reclaimer'
import { WORKTREE_STATES } from '@/types/reclaimer'
import cases from './classify.cases.json'

describe('classify — shared case table', () => {
  it('covers every state, every fallback action and every removal cause', () => {
    expect(new Set(cases.classifyCandidate.map((c) => c.expect.state))).toEqual(new Set(WORKTREE_STATES))
    expect(new Set(cases.fallbackDecision.map((c) => c.expect.action))).toEqual(new Set(['done', 'fallback', 'abort']))
    expect(new Set(cases.orphanVerdict.map((c) => c.expect))).toEqual(new Set(['skip', 'orphan']))
    expect(new Set(cases.classifyRemovalFailure.map((c) => c.expect))).toEqual(new Set(['file-in-use', 'long-path', 'unknown']))
  })

  for (const row of cases.classifyCandidate) {
    it(`classifyCandidate: ${row.name}`, () => {
      expect(classifyCandidate(row.input as ClassifyInput)).toEqual(row.expect)
    })
  }
  for (const row of cases.fallbackDecision) {
    it(`fallbackDecision: ${row.name}`, () => {
      expect(fallbackDecision(row.input as FallbackInput)).toEqual(row.expect)
    })
  }
  for (const row of cases.orphanVerdict) {
    it(`orphanVerdict: ${row.name}`, () => {
      expect(orphanVerdict(row.input as OrphanInput)).toBe(row.expect)
    })
  }
  for (const row of cases.classifyRemovalFailure) {
    it(`classifyRemovalFailure: ${row.name}`, () => {
      expect(classifyRemovalFailure(row.input)).toBe(row.expect)
    })
  }
})

describe('describeReason', () => {
  const base: ReasonInput = {
    state: 'unresolved',
    path: '/repo/.claude/worktrees/impl-9',
    itemState: null,
    correlation: null,
    lockReason: null,
    otherwiseRemovable: false,
    dirtyFiles: 0,
  }
  const issue = { number: 36, rung: 'branch-name' } as const

  it.each([
    ['an open item', { state: 'active', itemState: 'OPEN', correlation: issue }, '#36 open'],
    ['a protected worktree', { state: 'active' }, 'protected'],
    ['a merged item', { state: 'done', itemState: 'MERGED', correlation: issue }, '#36 merged (branch-name)'],
    ['a closed item', { state: 'done', itemState: 'CLOSED', correlation: { number: 7, rung: 'head-subject' } }, '#7 closed (head-subject)'],
    ['no work', { state: 'no-work' }, 'no work not already on the integration branch'],
    ['an outside path', { state: 'outside' }, 'registered path is outside the main worktree — never touched'],
    ['an unresolved correlated item', { correlation: issue }, '#36 could not be resolved'],
    ['an unresolved uncorrelated one', {}, 'no upstream branch, no #N subject, and HEAD is not on the integration branch'],
    ['a dirty correlated worktree', { state: 'dirty', correlation: issue, dirtyFiles: 3 }, '#36 otherwise reclaimable, but 3 uncommitted file(s)'],
    ['a dirty worktree whose status failed', { state: 'dirty', dirtyFiles: -1 }, 'otherwise reclaimable, but an unknown number of uncommitted file(s)'],
  ] as const)('%s', (_label, overrides, expected) => {
    expect(describeReason({ ...base, ...overrides })).toBe(expected)
  })

  const lockedPath = '/repo/.claude/worktrees/impl-9'
  it.each([
    ['a lock on live work stays a bare lock', { lockReason: 'agent running' }, 'locked: agent running'],
    ['a lock with no reason', {}, 'locked'],
    ['a finished clean lock', { otherwiseRemovable: true }, `locked — reclaimable once unlocked: git worktree unlock "${lockedPath}"`],
    [
      'a finished dirty lock',
      { otherwiseRemovable: true, lockReason: 'held', dirtyFiles: 2 },
      `locked: held; 2 uncommitted file(s) too — reclaimable once unlocked and forced: git worktree unlock "${lockedPath}"`,
    ],
    [
      'a finished lock whose status failed',
      { otherwiseRemovable: true, dirtyFiles: -1 },
      `locked; uncommitted status could not be checked too — reclaimable once unlocked and forced: git worktree unlock "${lockedPath}"`,
    ],
  ] as const)('%s', (_label, overrides, expected) => {
    expect(describeReason({ ...base, state: 'locked', ...overrides })).toBe(expected)
  })
})
