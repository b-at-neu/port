// The integration-red hold as the desktop planner reads it from a `## Integration red` comment on a ready-for-review pull request.
import { describe, expect, it } from 'vitest'
import type { IntegrationChecks } from '@/types/github'
import type { ReconciledItem } from '@/types/state'
import { createDispatchLedger, createRefreshMemo, createUnknownStreaks } from '@/main/tick/ledger'
import { planTick } from '@/main/tick/plan'
import { reconciledItem as item, repositoryState } from '../../../fixtures/board-state'

const COMMENT_AT = '2026-01-01T00:00:00Z'
const RED_BODY = '## Integration red\nHead `abc1234` · `dev` is already red on these checks, so the failure isn\'t from this diff:\n- `test` — FAILURE on `def5678` · https://example.test/run/1'

function reviewItem(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return item({
    number: 642,
    kind: 'pull-request',
    stages: [{ key: 'readyForReview', name: 'ready for review', role: 'trigger' }],
    headRefOid: 'abc1234def',
    mergeable: 'MERGEABLE',
    reviews: [],
    comments: [{ body: RED_BODY, createdAt: COMMENT_AT }],
    reviewCycleCount: 0,
    ...overrides,
  })
}

function plan(reviewed: ReconciledItem, integrationChecks: IntegrationChecks | null, now: string) {
  return planTick({
    repository: repositoryState([reviewed], { integrationChecks }, now),
    ledger: createDispatchLedger(),
    unknownStreaks: createUnknownStreaks(),
    nextDecisionAt: new Date(now),
    now: () => new Date(now),
    reviewCycleCap: 5,
    startedTasks: [],
    refreshMemo: createRefreshMemo(),
    checkDispositions: {},
    holdSessionRequired: true,
  })
}

describe('planTick — integration-red hold', () => {
  it('holds while a named check is still red on the integration branch, dispatching no review', () => {
    const report = plan(reviewItem(), { test: 'red' }, '2026-01-01T01:00:00.000Z')
    expect(report.actionable).toEqual([])
    expect(report.observations).toEqual([])
    expect(report.held).toEqual([
      {
        number: 642,
        kind: 'pull-request',
        trigger: 'readyForReview',
        reason: 'integration-red',
        contention: null,
        escalation: { kind: 'integration-red', checks: ['test'], state: 'red', escalateAt: '2026-01-02T00:00:00.000Z', expired: false },
      },
    ])
  })

  it('holds on an unreadable integration read rather than refreshing or dispatching', () => {
    const report = plan(reviewItem(), null, '2026-01-01T01:00:00.000Z')
    expect(report.actionable).toEqual([])
    expect(report.held[0]?.escalation).toEqual({ kind: 'integration-red', checks: ['test'], state: 'unreadable', escalateAt: '2026-01-02T00:00:00.000Z', expired: false })
  })

  it('hands the pull request to a refresh with no rebase comment once every named check is green', () => {
    const report = plan(reviewItem(), { test: 'green' }, '2026-01-01T01:00:00.000Z')
    expect(report.actionable).toEqual([])
    expect(report.held[0]?.reason).toBe('integration-green')
    expect(report.observations).toEqual([{ kind: 'refresh', number: 642, itemKind: 'pull-request', sourceLabel: 'readyForReview', headRefOid: 'abc1234def', count: 1, cause: 'integration-green' }])
  })

  it('escalates once the hold window has elapsed with the check still red', () => {
    const report = plan(reviewItem(), { test: 'red' }, '2026-01-02T00:00:00.000Z')
    expect(report.held[0]?.escalation).toEqual({ kind: 'integration-red', checks: ['test'], state: 'red', escalateAt: null, expired: true })
    expect(report.observations).toEqual([{ kind: 'integration-red', number: 642, itemKind: 'pull-request', checks: ['test'], headRefOid: 'abc1234def' }])
  })

  it('ignores a comment keyed to an older head, so a push ends the hold', () => {
    const report = plan(reviewItem({ headRefOid: 'fff9999000' }), { test: 'red' }, '2026-01-01T01:00:00.000Z')
    expect(report.held).toEqual([])
    expect(report.actionable).toHaveLength(1)
  })

  it('ignores the hold once a newer Gate cleared lifts it for one review', () => {
    const cleared = { body: '## Gate cleared', createdAt: '2026-01-01T00:30:00Z' }
    const report = plan(reviewItem({ comments: [{ body: RED_BODY, createdAt: COMMENT_AT }, cleared] }), { test: 'red' }, '2026-01-01T01:00:00.000Z')
    expect(report.held).toEqual([])
    expect(report.actionable).toHaveLength(1)
  })
})
