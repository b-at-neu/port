import { describe, expect, it } from 'vitest'
import type { OperatorMove } from '@/types/actions'
import { applyMove } from '@/main/pipeline/moves'
import type { Ticket } from '@/utils/pipeline/ticket'
import { NOW, queuedAt, ticketAt } from '../../../support/tickets'

const AT = '2026-11-23T13:00:00.000Z'

const paused = (detail: string): Ticket['status'] => ({ kind: 'held', on: 'paused', detail })
const waiting = (gate: 'plan-approval' | 'merge' | 'escalation', detail = ''): Ticket['status'] => ({ kind: 'waiting-on-you', gate, detail })
const running: Ticket['status'] = { kind: 'running', runId: 'run-1' }
const queuedNow = (reason: 'new' | 'changes-requested' | 'retry') => ({ kind: 'queued', reason, since: AT })

type Row = readonly [name: string, ticket: Ticket, move: OperatorMove, next: ReturnType<typeof applyMove>]

const ROWS: readonly Row[] = [
  ['pause holds a queued ticket and remembers why it was queued', ticketAt('review', queuedAt('changes-requested')), { kind: 'pause' }, { stage: 'review', status: paused('changes-requested') }],
  ['pause is not applicable to a ticket that is already paused', ticketAt('review', paused('new')), { kind: 'pause' }, null],
  ['pause re-holds a ticket held for another reason', ticketAt('implement', { kind: 'held', on: 'budget', detail: 'retry' }), { kind: 'pause' }, { stage: 'implement', status: paused('retry') }],
  ['pause is not applicable to a running ticket', ticketAt('implement', running), { kind: 'pause' }, null],
  ['resume re-queues a paused ticket under the reason it paused with', ticketAt('revise', paused('changes-requested')), { kind: 'resume' }, { stage: 'revise', status: queuedNow('changes-requested') }],
  ['resume falls back to retry for a detail naming no reason', ticketAt('implement', paused('')), { kind: 'resume' }, { stage: 'implement', status: queuedNow('retry') }],
  ['resume is not applicable to a queued ticket', ticketAt('plan', queuedAt()), { kind: 'resume' }, null],
  ['retry re-queues a running ticket', ticketAt('implement', running), { kind: 'retry' }, { stage: 'implement', status: queuedNow('retry') }],
  ['retry is not applicable to a queued ticket', ticketAt('implement', queuedAt()), { kind: 'retry' }, null],
  ['stop holds a running ticket for a retry', ticketAt('review', running), { kind: 'stop' }, { stage: 'review', status: paused('retry') }],
  ['stop is not applicable to a queued ticket', ticketAt('review', queuedAt()), { kind: 'stop' }, null],
  ['refresh interrupts a queued review', ticketAt('review', queuedAt()), { kind: 'refresh' }, { stage: 'refresh', status: queuedNow('new') }],
  ['refresh interrupts an approved merge', ticketAt('merge', waiting('merge')), { kind: 'refresh' }, { stage: 'refresh', status: queuedNow('new') }],
  ['refresh is not applicable to a running review', ticketAt('review', running), { kind: 'refresh' }, null],
  ['refresh is not applicable without a pull request', ticketAt('review', queuedAt(), { pr: null }), { kind: 'refresh' }, null],
  ['unblock to implementation re-queues a blocked implement', ticketAt('implement', { kind: 'blocked', on: [], reason: 'needs a decision' }), { kind: 'unblock', route: 'implementation' }, { stage: 'implement', status: queuedNow('new') }],
  ['unblock to review leaves an escalation for a fresh review', ticketAt('revise', waiting('escalation', 'cycle-cap')), { kind: 'unblock', route: 'review' }, { stage: 'review', status: queuedNow('new') }],
  ['unblock to revision leaves an escalation for a revision', ticketAt('review', waiting('escalation', 'zero-diff')), { kind: 'unblock', route: 'revision' }, { stage: 'revise', status: queuedNow('changes-requested') }],
  ['unblock is not applicable to a ticket that is not escalated', ticketAt('review', queuedAt()), { kind: 'unblock', route: 'review' }, null],
  ['revise sends an approved merge back to a revision and withdraws the approval', ticketAt('merge', waiting('merge'), { pr: { number: 900, approvedAt: NOW } }), { kind: 'revise' }, { stage: 'revise', status: queuedNow('changes-requested'), pr: { number: 900, approvedAt: null } }],
  ['revise is not applicable before the merge gate', ticketAt('review', queuedAt()), { kind: 'revise' }, null],
  ['grant leaves a queued revision where it is', ticketAt('revise', queuedAt('changes-requested')), { kind: 'grant' }, { stage: 'revise', status: queuedAt('changes-requested') }],
  ['grant is not applicable to a revision that is not asking for changes', ticketAt('revise', queuedAt('retry')), { kind: 'grant' }, null],
  ['approve-plan queues the implementation', ticketAt('plan', waiting('plan-approval')), { kind: 'approve-plan' }, { stage: 'implement', status: queuedNow('new') }],
  ['approve-plan is not applicable once the plan is approved', ticketAt('implement', queuedAt()), { kind: 'approve-plan' }, null],
  ['request-plan-changes re-queues the plan', ticketAt('plan', waiting('plan-approval')), { kind: 'request-plan-changes' }, { stage: 'plan', status: queuedNow('changes-requested') }],
  ['escalate waits on the operator with the detail it was given', ticketAt('revise', queuedAt('changes-requested')), { kind: 'escalate', detail: 'cycle-cap' }, { stage: 'revise', status: waiting('escalation', 'cycle-cap') }],
  ['escalate is not applicable to a ticket already waiting on you', ticketAt('merge', waiting('merge')), { kind: 'escalate', detail: 'cycle-cap' }, null],
]

describe('applyMove', () => {
  it.each(ROWS)('%s', (_name, ticket, move, next) => {
    expect(applyMove(ticket, move, AT)).toEqual(next)
  })
})
