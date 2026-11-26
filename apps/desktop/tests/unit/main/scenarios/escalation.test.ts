// A pull request reaching the review cycle cap: held, escalated, granted one more cycle, and dispatched again.
import { describe, expect, it } from 'vitest'
import { applyMove } from '@/main/pipeline/moves'
import { createRefreshMemo, createUnknownStreaks } from '@/main/pipeline/tick/ledger'
import { planTick } from '@/main/pipeline/tick/plan'
import type { ReconciledItem } from '@/types/state'
import { decisionsFor } from '@/utils/actions/decide'
import { gateClearedBody } from '@/utils/actions/bodies'
import type { Ticket } from '@/utils/pipeline/ticket'
import { ticketViewOf } from '@/utils/pipeline/stages'
import { reconciledItem, repositoryState } from '../../../support/board-snapshot'
import { queuedAt, ticketAt } from '../../../support/tickets'

const NOW = new Date('2026-01-01T01:00:00.000Z')
const CAP = 5

function pullRequest(ticket: Ticket, overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return reconciledItem({ number: 900, kind: 'pull-request', ticket, headRefOid: 'sha1', mergeable: 'MERGEABLE', reviews: [], comments: [], reviewCycleCount: CAP, ...overrides })
}

function planOver(item: ReconciledItem) {
  return planTick({
    repository: repositoryState([item], {}, NOW.toISOString()),
    unknownStreaks: createUnknownStreaks(),
    nextDecisionAt: new Date('2026-01-01T01:01:00.000Z'),
    now: () => NOW,
    reviewCycleCap: CAP,
    startedTasks: [],
    refreshMemo: createRefreshMemo(),
    checkDispositions: {},
    holdSessionRequired: false,
  })
}

const decisionsOver = (item: ReconciledItem) => decisionsFor({ view: item.ticket === null ? null : ticketViewOf(item.ticket), item, viewer: 'op', reviewCycleCap: CAP, liveStage: false })

describe('a pull request at the review cycle cap', () => {
  const revise = (): ReconciledItem => pullRequest(ticketAt('revise', queuedAt('changes-requested'), { reviewCycles: CAP }))

  it('holds a queued revision on the cap and offers the operator a grant', () => {
    const item = revise()
    const report = planOver(item)
    expect(report.actionable).toEqual([])
    expect(report.held).toMatchObject([{ number: 900, stage: 'revise', reason: 'cycle-cap', escalation: { kind: 'cycle-cap', count: CAP, cap: CAP } }])
    expect(decisionsOver(item).grant).toMatchObject({ available: true })
  })

  it('makes the revision actionable once the operator grants one more cycle', () => {
    const grant = { body: gateClearedBody('revision', { cycleGrant: true }) ?? '', createdAt: '2026-01-01T00:30:00Z' }
    const item = pullRequest(ticketAt('revise', queuedAt('changes-requested'), { reviewCycles: CAP }), { comments: [grant] })
    const report = planOver(item)
    expect(report.held).toEqual([])
    expect(report.actionable).toMatchObject([{ number: 900, stage: 'revise', cycle: { count: CAP, cap: CAP + 1 } }])
  })

  it('never holds a refresh on the cap — a rebase is not a review cycle', () => {
    const report = planOver(pullRequest(ticketAt('refresh', queuedAt('new'), { reviewCycles: CAP })))
    expect(report.held).toEqual([])
    expect(report.actionable).toMatchObject([{ number: 900, stage: 'refresh', cycle: null }])
  })

  it('moves an operator-refreshed review at the cap to a refresh, not a held escalation', () => {
    const ticket = ticketAt('review', queuedAt(), { reviewCycles: CAP })
    expect(applyMove(ticket, { kind: 'refresh' }, NOW.toISOString())).toMatchObject({ stage: 'refresh', status: { kind: 'queued' } })
  })

  it('waits on the operator once escalated, and no longer offers a grant', () => {
    const next = applyMove(ticketAt('revise', queuedAt('changes-requested'), { reviewCycles: CAP }), { kind: 'escalate', detail: 'cycle-cap' }, NOW.toISOString())
    expect(next).toMatchObject({ stage: 'revise', status: { kind: 'waiting-on-you', gate: 'escalation', detail: 'cycle-cap' } })
    const escalated = pullRequest(ticketAt('revise', { kind: 'waiting-on-you', gate: 'escalation', detail: 'cycle-cap' }, { reviewCycles: CAP }))
    expect(planOver(escalated).actionable).toEqual([])
    expect(decisionsOver(escalated).grant).toEqual({ available: false, reason: 'not-applicable' })
  })
})
