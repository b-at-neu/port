// One ticket's path from plan to merge, every step read off its record: the tick dispatches what the record queues, and operator moves advance it.
import { describe, expect, it } from 'vitest'
import { applyMove } from '@/main/pipeline/moves'
import { createRefreshMemo, createUnknownStreaks } from '@/main/pipeline/tick/ledger'
import { planTick } from '@/main/pipeline/tick/plan'
import type { ReconciledItem } from '@/types/state'
import type { Ticket } from '@/utils/pipeline/ticket'
import { reconciledItem, repositoryState } from '../../../support/board-snapshot'
import { queuedAt, ticketAt } from '../../../support/tickets'

const NOW = new Date('2026-01-01T01:00:00.000Z')

function tickOver(item: ReconciledItem) {
  return planTick({
    repository: repositoryState([item], {}, NOW.toISOString()),
    unknownStreaks: createUnknownStreaks(),
    nextDecisionAt: new Date('2026-01-01T01:01:00.000Z'),
    now: () => NOW,
    reviewCycleCap: 5,
    startedTasks: [],
    refreshMemo: createRefreshMemo(),
    checkDispositions: {},
    holdSessionRequired: false,
  })
}

const issueItem = (ticket: Ticket): ReconciledItem => reconciledItem({ number: 52, kind: 'issue', ticket })
const prItem = (ticket: Ticket): ReconciledItem => reconciledItem({ number: 900, kind: 'pull-request', ticket, linked: 52, headRefOid: 'sha1', mergeable: 'MERGEABLE', reviews: [], comments: [], reviewCycleCount: 0 })

/** Applies a move to a ticket the way the operator write does, keeping the rest of the record. */
function advance(ticket: Ticket, move: Parameters<typeof applyMove>[1]): Ticket {
  const next = applyMove(ticket, move, NOW.toISOString())
  if (next === null) throw new Error(`move ${move.kind} does not apply`)
  return { ...ticket, stage: next.stage, status: next.status, pr: next.pr ?? ticket.pr }
}

describe('a ticket moving from plan to merge', () => {
  it('is dispatched at each stage its record queues, with the agent that stage runs', () => {
    const planning = ticketAt('plan', queuedAt(), { ticket: 52 })
    expect(tickOver(issueItem(planning)).actionable).toMatchObject([{ number: 52, stage: 'plan', agent: 'plan' }])

    const approved = advance(ticketAt('plan', { kind: 'waiting-on-you', gate: 'plan-approval', detail: '' }, { ticket: 52 }), { kind: 'approve-plan' })
    expect(approved).toMatchObject({ stage: 'implement', status: { kind: 'queued' } })
    expect(tickOver(issueItem(approved)).actionable).toMatchObject([{ number: 52, stage: 'implement', agent: 'impl' }])

    const inReview = ticketAt('review', queuedAt(), { ticket: 52 })
    expect(tickOver(prItem(inReview)).actionable).toMatchObject([{ number: 900, stage: 'review', agent: 'review' }])
  })

  it('stops being dispatched while running, and again once paused', () => {
    const running = ticketAt('implement', { kind: 'running', runId: 'run-1' }, { ticket: 52 })
    expect(tickOver(issueItem(running)).actionable).toEqual([])

    const paused = advance(ticketAt('implement', queuedAt(), { ticket: 52 }), { kind: 'pause' })
    const report = tickOver(issueItem(paused))
    expect(report.actionable).toEqual([])
    expect(paused.status).toMatchObject({ kind: 'held', on: 'paused' })

    const resumed = advance(paused, { kind: 'resume' })
    expect(tickOver(issueItem(resumed)).actionable).toMatchObject([{ number: 52, stage: 'implement' }])
  })

  it('goes back to a revision from the merge gate, and the tick dispatches it', () => {
    const atMerge = ticketAt('merge', { kind: 'waiting-on-you', gate: 'merge', detail: '' }, { ticket: 52 })
    expect(tickOver(prItem(atMerge)).actionable).toEqual([])

    const revising = advance(atMerge, { kind: 'revise' })
    expect(revising).toMatchObject({ stage: 'revise', status: { kind: 'queued', reason: 'changes-requested' } })
    expect(tickOver(prItem(revising)).actionable).toMatchObject([{ number: 900, stage: 'revise', agent: 'revise' }])
  })
})
