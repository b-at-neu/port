// The zero-diff gate's check-only hold, as the desktop planner reads it from the rollup on a ready-for-review pull request.
import { describe, expect, it } from 'vitest'
import type { CheckContext } from '@/types/github'
import type { ReconciledItem } from '@/types/state'
import type { RerunMemo } from '@/types/tick'
import type { RepoId } from '@/utils/repos'
import { createDispatchLedger, createRefreshMemo, createRerunMemo, createUnknownStreaks } from '@/main/pipeline/tick/ledger'
import { planTick } from '@/main/pipeline/tick/plan'
import { reconciledItem as item, repositoryState } from '../../../support/board-snapshot'

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

function plan(reviewed: ReconciledItem, rerunMemo: RerunMemo = createRerunMemo()) {
  return planTick({
    repository: repositoryState([reviewed], {}, NOW.toISOString()),
    ledger: createDispatchLedger(),
    unknownStreaks: createUnknownStreaks(),
    nextDecisionAt: new Date('2026-01-01T01:01:00.000Z'),
    now: () => NOW,
    reviewCycleCap: 5,
    startedTasks: [],
    refreshMemo: createRefreshMemo(),
    rerunMemo,
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

  it('dispatches one more review, never escalating, when the review carries no marker', () => {
    const report = plan(reviewItem({ checkRollup: [run('FAILURE')], reviews: [{ body: '## Code Review — Cycle 1 · needs revision\n1 🔴 Critical\nBlocked by code findings.', submittedAt: '2026-01-01T00:30:00Z', commitOid: 'sha1' }] }))
    expect(report.held).toEqual([])
    expect(report.actionable).toHaveLength(1)
  })

  it('dispatches one more review, never escalating, when the rollup was never selected', () => {
    const report = plan(reviewItem({ checkRollup: null }))
    expect(report.held).toEqual([])
    expect(report.actionable).toHaveLength(1)
  })
})

describe('planTick — re-running a red check-hold once per head', () => {
  const ACTIONS_URL = 'https://github.com/o/r/actions/runs/777/job/9'
  const red = (): CheckContext => ({ ...run('FAILURE'), url: ACTIONS_URL })

  it('asks for one failed-jobs re-run of the Actions run behind the red check', () => {
    const report = plan(reviewItem({ checkRollup: [red()] }))
    expect(report.observations).toEqual([{ kind: 'rerun-checks', number: 594, itemKind: 'pull-request', runs: [{ check: 'run-e2e', runId: '777' }], headRefOid: 'sha1' }])
  })

  it('asks for nothing once that head was re-run, and again when the head moves', () => {
    const memo = createRerunMemo()
    memo.set('repo-a' as RepoId, 594, 'sha1')
    expect(plan(reviewItem({ checkRollup: [red()] }), memo).observations).toEqual([])
    const moved = plan(reviewItem({ checkRollup: [red()], headRefOid: 'sha2', reviews: [{ body: MARKER_BODY, submittedAt: '2026-01-01T00:30:00Z', commitOid: 'sha2' }] }), memo)
    expect(moved.observations).toHaveLength(1)
  })

  it('never re-runs a check outside Actions, and holds as before', () => {
    const report = plan(reviewItem({ checkRollup: [{ ...run('FAILURE'), url: 'https://ci.example.com/build/1' }] }))
    expect(report.observations).toEqual([])
    expect(report.held[0]?.reason).toBe('check-hold')
  })

  it('never re-runs a check that is only pending', () => {
    const report = plan(reviewItem({ checkRollup: [{ ...run(null, 'IN_PROGRESS'), url: ACTIONS_URL }] }))
    expect(report.observations).toEqual([])
  })
})
