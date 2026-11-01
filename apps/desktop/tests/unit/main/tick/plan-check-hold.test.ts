// The zero-diff gate's check-only hold, as the desktop planner reads it from the rollup on a ready-for-review pull request.
import { describe, expect, it } from 'vitest'
import type { CheckContext } from '@/types/github'
import type { ReconciledItem } from '@/types/state'
import { createDispatchLedger, createRefreshMemo, createUnknownStreaks } from '@/main/tick/ledger'
import { planTick } from '@/main/tick/plan'
import { reconciledItem as item, repositoryState } from '../../../fixtures/board-state'

const NOW = new Date('2026-01-01T01:00:00.000Z')
const MARKER_BODY = '## Code Review — Cycle 1 · needs revision\n1 🔴 Critical\nBlocked only by checks: `run-e2e`'

function run(conclusion: string | null, status: 'COMPLETED' | 'IN_PROGRESS' = 'COMPLETED'): CheckContext {
  return { __typename: 'CheckRun', name: 'run-e2e', conclusion, status, state: null, startedAt: '2026-01-01T00:00:00Z', completedAt: null, createdAt: null, url: null }
}

function reviewItem(overrides: Partial<ReconciledItem>): ReconciledItem {
  return item({
    number: 594,
    kind: 'pull-request',
    stages: [{ key: 'readyForReview', name: 'ready for review', role: 'trigger' }],
    headRefOid: 'sha1',
    mergeable: 'MERGEABLE',
    reviews: [{ body: MARKER_BODY, submittedAt: '2026-01-01T00:30:00Z', commitOid: 'sha1' }],
    comments: [],
    reviewCycleCount: 1,
    ...overrides,
  })
}

function plan(reviewed: ReconciledItem) {
  return planTick({
    repository: repositoryState([reviewed], {}, NOW.toISOString()),
    ledger: createDispatchLedger(),
    unknownStreaks: createUnknownStreaks(),
    nextDecisionAt: new Date('2026-01-01T01:01:00.000Z'),
    now: () => NOW,
    reviewCycleCap: 5,
    startedTasks: [],
    refreshMemo: createRefreshMemo(),
    checkDispositions: {},
    holdSessionRequired: true,
  })
}

describe('planTick — check-hold on the zero-diff gate', () => {
  it('holds while the named check is pending, dispatching no review', () => {
    const report = plan(reviewItem({ checkRollup: [run(null, 'IN_PROGRESS')] }))
    expect(report.actionable).toEqual([])
    expect(report.held).toEqual([
      {
        number: 594,
        kind: 'pull-request',
        trigger: 'readyForReview',
        reason: 'check-hold',
        contention: null,
        escalation: { kind: 'check-hold', checks: ['run-e2e'], state: 'pending', escalateAt: null },
      },
    ])
  })

  it('holds a red check inside the window, naming the deadline', () => {
    const report = plan(reviewItem({ checkRollup: [run('FAILURE')] }))
    expect(report.held[0]?.escalation).toEqual({ kind: 'check-hold', checks: ['run-e2e'], state: 'red', escalateAt: '2026-01-01T02:30:00.000Z' })
    expect(report.actionable).toEqual([])
  })

  it('dispatches one review once the check is green and the rollup is clear', () => {
    const report = plan(reviewItem({ checkRollup: [run('SUCCESS')] }))
    expect(report.held).toEqual([])
    expect(report.actionable).toEqual([{ number: 594, kind: 'pull-request', trigger: 'readyForReview', agent: 'review', unchecked: false, cycle: { count: 1, cap: 5 } }])
  })

  it('escalates as zero-diff when the review carries no marker', () => {
    const report = plan(reviewItem({ checkRollup: [run('FAILURE')], reviews: [{ body: '## Code Review — Cycle 1 · needs revision\n1 🔴 Critical\nBlocked by code findings.', submittedAt: '2026-01-01T00:30:00Z', commitOid: 'sha1' }] }))
    expect(report.held[0]?.reason).toBe('zero-diff')
  })

  it('escalates as zero-diff when the rollup was never selected', () => {
    const report = plan(reviewItem({ checkRollup: null }))
    expect(report.held[0]?.reason).toBe('zero-diff')
  })
})
