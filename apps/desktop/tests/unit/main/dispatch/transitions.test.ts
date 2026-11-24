import { describe, expect, it } from 'vitest'
import { HANDBACK_TOKENS, accepts, actionOf, applyEvent, eventWrites, handbackRefusal, itemKindFor, pullRequestNumberOf, stageModeFor, ticketEventOf, type TableContext } from '@/main/pipeline/transitions'
import { stageOfMode, type StageEvent, type StageMode, type StagePlanFile, type TicketEvent } from '@/types/stage-labels'
import type { Stage, Status, Ticket } from '@/utils/pipeline/ticket'
import { NOW, REPO, ticketOf } from '../../../support/tickets'

const LATER = '2026-11-24T00:00:00.000Z'
const CTX: TableContext = { at: LATER, actor: null, repo: REPO, ref: { kind: 'issue', number: 843 } }

const queued = (reason: 'new' | 'changes-requested' | 'retry' = 'new'): Status => ({ kind: 'queued', reason, since: NOW })
const running: Status = { kind: 'running', runId: null }
const waiting = (gate: 'plan-approval' | 'merge' | 'escalation'): Status => ({ kind: 'waiting-on-you', gate, detail: '' })
const pr = (approvedAt: string | null = null): Pick<Ticket, 'pr'> => ({ pr: { number: 9, approvedAt } })
const at = (stage: Stage, status: Status, extra: Partial<Ticket> = {}): Ticket => ticketOf({ stage, status, ...extra })

const handback = (stage: Stage, token: string, arg: string | null = null, prNumber: number | null = null): TicketEvent => ({ kind: 'handback', stage, token, arg, pr: prNumber, via: 'session' })

function ok(ticket: Ticket | null, event: TicketEvent) {
  const result = applyEvent(ticket, event, CTX)
  if (!result.ok) throw new Error(`refused: ${result.reason}`)
  return result
}

const refusal = (ticket: Ticket | null, event: TicketEvent) => {
  const result = applyEvent(ticket, event, CTX)
  return result.ok ? 'applied' : result.reason
}

describe('claim, rollback and error-reset', () => {
  it.each([
    ['plan', queued('new')],
    ['plan', queued('changes-requested')],
    ['implement', queued('new')],
    ['review', queued('new')],
    ['revise', queued('changes-requested')],
    ['refresh', queued('new')],
    ['implement', queued('retry')],
  ] as const)('claims a queued %s ticket', (stage, status) => {
    expect(ok(at(stage, status), { kind: 'claim', stage }).ticket).toMatchObject({ stage, status: { kind: 'running' }, rev: 1 })
  })

  it.each(['rollback', 'error-reset'] as const)('%s returns a running ticket to a retry, and an implementation block too', (kind) => {
    expect(ok(at('review', running), { kind, stage: 'review' }).ticket.status).toEqual({ kind: 'queued', reason: 'retry', since: LATER })
    expect(ok(at('implement', { kind: 'blocked', on: [], reason: '' }), { kind, stage: 'implement' }).ticket.status).toMatchObject({ kind: 'queued', reason: 'retry' })
  })

  it.each([
    ['a claim of a running ticket', at('implement', running), { kind: 'claim', stage: 'implement' }],
    ['a claim at another stage', at('implement', queued()), { kind: 'claim', stage: 'review' }],
    ['a claim of a ticket on a human', at('plan', waiting('plan-approval')), { kind: 'claim', stage: 'plan' }],
    ['a rollback of a queued ticket', at('review', queued()), { kind: 'rollback', stage: 'review' }],
    ['a rollback of a blocked review', at('review', { kind: 'blocked', on: [], reason: '' }), { kind: 'rollback', stage: 'review' }],
    ['an error reset at another stage', at('review', running), { kind: 'error-reset', stage: 'revise' }],
    ['any event on a missing ticket', null, { kind: 'claim', stage: 'plan' }],
  ] as const)('refuses %s as moved', (_name, ticket, event) => {
    expect(refusal(ticket, event)).toBe('moved')
  })
})

describe('blocked and the next turn', () => {
  it('moves an implementation to blocked, and back on the next turn', () => {
    const blocked = ok(at('implement', running), { kind: 'blocked', stage: 'implement' }).ticket
    expect(blocked.status).toEqual({ kind: 'blocked', on: [], reason: '' })
    expect(ok(blocked, { kind: 'resumed-turn', stage: 'implement' }).ticket.status).toEqual(running)
  })

  it.each([
    ['blocked from a queued ticket', at('implement', queued()), { kind: 'blocked', stage: 'implement' }],
    ['the next turn once the human cleared the block', at('implement', running), { kind: 'resumed-turn', stage: 'implement' }],
    ['the next turn of another stage', at('review', { kind: 'blocked', on: [], reason: '' }), { kind: 'resumed-turn', stage: 'implement' }],
  ] as const)('refuses %s', (_name, ticket, event) => {
    expect(refusal(ticket, event)).toBe('moved')
  })
})

describe('hand-backs', () => {
  const HANDBACKS = [
    ['plan-written', at('plan', running), handback('plan', 'plan-written'), { stage: 'plan', kind: 'waiting-on-you', gate: 'plan-approval' }],
    ['pr-opened', at('implement', running), handback('implement', 'pr-opened', '#9', 9), { stage: 'review', kind: 'queued', prNumber: 9 }],
    ['approved', at('review', running, pr()), handback('review', 'approved'), { stage: 'merge', kind: 'waiting-on-you', gate: 'merge', approvedAt: LATER }],
    ['needs-revision', at('review', running, pr()), handback('review', 'needs-revision'), { stage: 'revise', kind: 'queued', reason: 'changes-requested' }],
    ['checks-pending', at('review', running, pr()), handback('review', 'checks-pending'), { stage: 'review', kind: 'waiting-on-you', gate: 'escalation' }],
    ['rebase-required', at('review', running, pr()), handback('review', 'rebase-required'), { stage: 'refresh', kind: 'queued', reason: 'new' }],
    ['head-moved', at('review', running, pr()), handback('review', 'head-moved'), { stage: 'review', kind: 'queued', reason: 'new' }],
    ['revised', at('revise', running, pr()), handback('revise', 'revised'), { stage: 'review', kind: 'queued', reason: 'new' }],
    ['revise escalated', at('revise', running, pr()), handback('revise', 'escalated'), { stage: 'revise', kind: 'waiting-on-you', gate: 'escalation' }],
    ['refreshed clean, unapproved', at('refresh', running, pr()), handback('refresh', 'refreshed', 'clean'), { stage: 'review', kind: 'queued', reason: 'new' }],
    ['refreshed clean, approved', at('refresh', running, pr(NOW)), handback('refresh', 'refreshed', 'clean'), { stage: 'merge', kind: 'waiting-on-you', gate: 'merge', approvedAt: NOW }],
    ['refreshed resolved, approved', at('refresh', running, pr(NOW)), handback('refresh', 'refreshed', 'resolved'), { stage: 'review', kind: 'queued', reason: 'new', approvedAt: null }],
    ['refresh escalated, approved', at('refresh', running, pr(NOW)), handback('refresh', 'escalated'), { stage: 'refresh', kind: 'waiting-on-you', gate: 'escalation', approvedAt: null }],
  ] as const

  it.each(HANDBACKS)('%s', (_name, ticket, event, expected) => {
    const { ticket: next } = ok(ticket, event)
    expect(next).toMatchObject({ stage: expected.stage, status: { kind: expected.kind }, rev: 1 })
    if (next.status.kind === 'queued' && 'reason' in expected) expect(next.status.reason).toBe(expected.reason)
    if (next.status.kind === 'waiting-on-you' && 'gate' in expected) expect(next.status.gate).toBe(expected.gate)
    if ('approvedAt' in expected) expect(next.pr?.approvedAt).toBe(expected.approvedAt)
    if ('prNumber' in expected) expect(next.pr).toEqual({ number: 9, approvedAt: null })
  })

  it('settles a ticket a liveness reset already put back in the queue', () => {
    expect(ok(at('review', queued('retry'), pr()), handback('review', 'approved')).ticket).toMatchObject({ stage: 'merge', status: { kind: 'waiting-on-you' } })
    expect(ok(at('plan', queued('retry')), handback('plan', 'plan-written')).ticket.status).toMatchObject({ kind: 'waiting-on-you' })
  })

  it('opens a pull request from a blocked issue, and from one queued behind an already open pull request', () => {
    const statuses: Status[] = [{ kind: 'blocked', on: [], reason: '' }, queued('new')]
    for (const status of statuses) {
      expect(ok(at('implement', status), handback('implement', 'pr-opened', '9', 9)).ticket.stage).toBe('review')
    }
  })

  it('leaves a head-moved hand-back on a ticket the reset already queued for review unchanged', () => {
    const reset = at('review', queued('retry'), pr())
    expect(ok(reset, handback('review', 'head-moved'))).toMatchObject({ changed: false, ticket: reset })
  })

  it.each([
    ['a ticket on a human', at('review', waiting('escalation'), pr()), handback('review', 'approved')],
    ['another stage', at('revise', running, pr()), handback('review', 'approved')],
    ['a queued ticket that was never claimed', at('review', queued('new'), pr()), handback('review', 'approved')],
    ['a freshly queued plan', at('plan', queued('new')), handback('plan', 'plan-written')],
  ] as const)('are moved for %s', (_name, ticket, event) => {
    expect(refusal(ticket, event)).toBe('moved')
  })

  it.each([
    ['a token outside the stage', at('plan', running), handback('plan', 'approved')],
    ['a pr-opened with no pull request', at('implement', running), handback('implement', 'pr-opened')],
    ['a refresh with neither clean nor resolved', at('refresh', running, pr()), handback('refresh', 'refreshed', 'dirty')],
  ] as const)('refuse %s as unknown', (_name, ticket, event) => {
    expect(refusal(ticket, event)).toBe('unknown-handback')
  })
})

describe('merged', () => {
  it('marks any ticket done, once', () => {
    const done = ok(at('review', running, pr()), { kind: 'merged' })
    expect(done.ticket).toMatchObject({ stage: 'merge', status: { kind: 'done', at: LATER } })
    expect(ok(done.ticket, { kind: 'merged' })).toMatchObject({ changed: false })
  })
})

describe('what a commit records', () => {
  it('bumps rev and appends one event with the stage, the status and the label diff of both halves', () => {
    const { ticket } = ok(at('implement', running), handback('implement', 'pr-opened', '9', 9))
    expect(ticket.rev).toBe(1)
    expect(ticket.history).toEqual([
      { at: LATER, action: 'stage-handback-pr-opened', actor: null, to: { stage: 'review', status: 'queued' }, legacy: { add: ['issue:prOpened', 'pull-request:marker', 'pull-request:readyForReview'], remove: ['issue:inProgress'] } },
    ])
  })

  it('leaves rev alone when nothing changed', () => {
    expect(ok(at('review', queued('retry'), pr()), handback('review', 'head-moved'))).toMatchObject({ changed: false, ticket: { rev: 0 } })
  })

  it('bounds the history', () => {
    let ticket = at('implement', queued())
    for (let i = 0; i < 60; i++) {
      ticket = ok(ticket, ticket.status.kind === 'queued' ? { kind: 'claim', stage: 'implement' } : { kind: 'rollback', stage: 'implement' }).ticket
    }
    expect(ticket.history).toHaveLength(60)
    for (let i = 0; i < 60; i++) {
      ticket = ok(ticket, ticket.status.kind === 'queued' ? { kind: 'claim', stage: 'implement' } : { kind: 'rollback', stage: 'implement' }).ticket
    }
    expect(ticket.history).toHaveLength(100)
  })

  it.each([
    ['approved', 1],
    ['needs-revision', 1],
    ['checks-pending', 1],
    ['rebase-required', 0],
    ['head-moved', 0],
  ])('review %s counts %i review cycles', (token, cycles) => {
    expect(ok(at('review', running, { ...pr(), reviewCycles: 2 }), handback('review', token)).ticket.reviewCycles).toBe(2 + cycles)
  })

  it('does not count an adopted verdict', () => {
    const adopted: TicketEvent = { kind: 'handback', stage: 'review', token: 'approved', arg: null, pr: null, via: 'adopt' }
    expect(ok(at('review', running, pr()), adopted).ticket.reviewCycles).toBe(0)
  })

  it.each([
    [{ kind: 'claim', stage: 'plan' }, 'stage-claim'],
    [{ kind: 'rollback', stage: 'plan' }, 'stage-rollback'],
    [{ kind: 'error-reset', stage: 'plan' }, 'stage-error-reset'],
    [{ kind: 'blocked', stage: 'implement' }, 'stage-blocked'],
    [{ kind: 'resumed-turn', stage: 'implement' }, 'stage-unblocked'],
    [{ kind: 'merged' }, 'mirror-merged'],
    [handback('review', 'approved'), 'stage-handback-approved'],
    [{ ...handback('review', 'approved'), via: 'adopt' }, 'stage-adopt-approved'],
    [handback('refresh', 'refreshed', 'clean'), 'stage-handback-refreshed-clean'],
  ] as const)('names %j %s in the audit log', (event, action) => {
    expect(actionOf(event)).toBe(action)
  })
})

describe('labels, the transitional event', () => {
  const labels = (overrides: Partial<Extract<TicketEvent, { kind: 'labels' }>> = {}): TicketEvent => ({ kind: 'labels', itemKind: 'issue', add: [], remove: [], expect: { present: [], absent: [] }, action: 'gate-approve', issue: null, ...overrides })

  it('creates a ticket from nothing, which Work on can then claim', () => {
    const { ticket } = ok(null, labels({ add: ['marker', 'ready'], expect: { present: [], absent: ['marker'] } }))
    expect(ticket).toMatchObject({ rev: 0, ticket: 843, stage: 'plan', status: { kind: 'queued', reason: 'new' } })
    expect(ticket.history[0]).toMatchObject({ legacy: { add: ['issue:marker', 'issue:ready'], remove: [] } })
  })

  it('creates a pull request under the issue its branch names', () => {
    const event = labels({ itemKind: 'pull-request', add: ['readyForReview'], issue: 12 })
    expect(applyEvent(null, event, { ...CTX, ref: { kind: 'pull-request', number: 40 } })).toMatchObject({ ok: true, ticket: { ticket: 12, pr: { number: 40 }, stage: 'review' } })
  })

  it.each([
    ['an expected key that is not there', { expect: { present: ['planApproved' as const], absent: [] } }],
    ['an expected-absent key that is', { expect: { present: [], absent: ['ready' as const] } }],
  ])('refuses %s', (_name, overrides) => {
    expect(refusal(at('plan', queued()), labels(overrides))).toBe('moved')
  })

  it('refuses an expectation of a missing ticket', () => {
    expect(refusal(null, labels({ expect: { present: ['ready'], absent: [] } }))).toBe('moved')
  })

  it('swaps keys, and records the swap in the history', () => {
    const { ticket } = ok(at('plan', queued()), labels({ add: ['planning'], remove: ['ready'], action: 'stage-claim' }))
    expect(ticket).toMatchObject({ rev: 1, status: { kind: 'running' } })
    expect(ticket.history.at(-1)).toMatchObject({ action: 'stage-claim', legacy: { add: ['issue:planning'], remove: ['issue:ready'] } })
  })

  it('reports no change for keys that land where the ticket already is, and for a marker a ticket cannot lose', () => {
    const ticket = at('plan', queued())
    expect(ok(ticket, labels({ add: ['ready'] }))).toMatchObject({ changed: false, ticket })
    expect(ok(ticket, labels({ remove: ['marker'] }))).toMatchObject({ changed: false })
  })

  it('writes the pull request half, and sets approval when the keys say approved', () => {
    const result = applyEvent(at('review', queued(), pr()), labels({ itemKind: 'pull-request', add: ['approved'], remove: ['readyForReview'] }), { ...CTX, ref: { kind: 'pull-request', number: 9 } })
    expect(result.ok && result.ticket).toMatchObject({ stage: 'merge', status: { kind: 'waiting-on-you', gate: 'merge' }, pr: { number: 9, approvedAt: LATER } })
  })

  it('keeps the stage a lone needsHuman interrupted, and the stage a stop left behind', () => {
    const escalate = applyEvent(at('review', running, pr()), labels({ itemKind: 'pull-request', add: ['needsHuman'], remove: ['reviewing'] }), { ...CTX, ref: { kind: 'pull-request', number: 9 } })
    expect(escalate.ok && escalate.ticket).toMatchObject({ stage: 'review', status: { kind: 'waiting-on-you', gate: 'escalation' } })
    expect(ok(at('implement', running), labels({ remove: ['inProgress'] })).ticket).toMatchObject({ stage: 'implement', status: { kind: 'held' } })
  })

  it('toggles auto-plan', () => {
    expect(ok(at('plan', queued()), labels({ add: ['autoPlan'] })).ticket.autoPlan).toBe(true)
  })
})

describe('accepts', () => {
  it('says whether the table would take an event, committing nothing', () => {
    const ticket = at('implement', queued())
    expect(accepts(ticket, { kind: 'claim', stage: 'implement' }, CTX.ref, REPO)).toBe(true)
    expect(accepts(ticket, { kind: 'rollback', stage: 'implement' }, CTX.ref, REPO)).toBe(false)
    expect(accepts(null, { kind: 'claim', stage: 'implement' }, CTX.ref, REPO)).toBe(false)
    expect(ticket.rev).toBe(0)
  })
})

describe('ticketEventOf', () => {
  const outcome = (kind: Extract<StageEvent, { kind: 'outcome' }>['outcome'], token: string | null = null, arg: string | null = null): StageEvent => ({ kind: 'outcome', outcome: kind, handback: token === null ? null : { token, arg }, plan: null })

  it.each([
    [{ kind: 'claim' }, 'refresh', { kind: 'claim', stage: 'refresh' }],
    [{ kind: 'rollback' }, 'impl', { kind: 'rollback', stage: 'implement' }],
    [{ kind: 'resumed-turn' }, 'impl', { kind: 'resumed-turn', stage: 'implement' }],
    [{ kind: 'resumed-turn' }, 'review', null],
    [outcome('blocked'), 'impl', { kind: 'blocked', stage: 'implement' }],
    [outcome('blocked'), 'plan', null],
    [outcome('error'), 'revise', { kind: 'error-reset', stage: 'revise' }],
    [outcome('questions'), 'impl', null],
    [outcome('interrupted'), 'impl', null],
    [outcome('usage-limit'), 'impl', null],
    [outcome('completed'), 'plan', null],
    [outcome('completed', 'pr-opened', '#8'), 'impl', { kind: 'handback', stage: 'implement', token: 'pr-opened', arg: '#8', pr: 8, via: 'session' }],
    [{ kind: 'adopt', handback: { token: 'approved', arg: null } }, 'review', { kind: 'handback', stage: 'review', token: 'approved', arg: null, pr: null, via: 'adopt' }],
  ] as const)('%j in %s mode', (event, mode, expected) => {
    expect(ticketEventOf(event, mode)).toEqual(expected)
  })
})

describe('unusable hand-backs', () => {
  const planWritten = (plan: StagePlanFile | null): StageEvent => ({ kind: 'outcome', outcome: 'completed', handback: { token: 'plan-written', arg: null }, plan })
  const done = (mode: StageMode, token: string, arg: string | null = null) => handbackRefusal({ kind: 'outcome', outcome: 'completed', handback: { token, arg }, plan: null }, mode)

  it('completed with no hand-back line is no-handback', () => {
    expect(handbackRefusal({ kind: 'outcome', outcome: 'completed', handback: null, plan: null }, 'plan')).toBe('no-handback')
  })

  it.each([
    [null, 'no-plan-file'],
    [{ kind: 'missing', detail: 'EACCES' }, 'no-plan-file'],
    [{ kind: 'empty' }, 'empty-plan-file'],
    [{ kind: 'read', body: 'body' }, null],
  ] as const)('plan-written with plan file %j is %s', (plan, refusal) => {
    expect(handbackRefusal(planWritten(plan), 'plan')).toBe(refusal)
  })

  it.each([
    ['plan', 'approved', null],
    ['review', 'plan-written', null],
    ['impl', 'pr-opened', null],
    ['impl', 'pr-opened', 'eight'],
    ['refresh', 'refreshed', null],
    ['refresh', 'refreshed', 'dirty'],
    ['plan', 'Plan-Written', null],
  ] as const)('%s %s %s is unknown-handback', (mode, token, arg) => {
    expect(done(mode, token, arg)).toBe('unknown-handback')
  })

  it('reads no labels, so it can run before any read, and passes the events that carry no hand-back', () => {
    expect(done('impl', 'pr-opened', '#8')).toBeNull()
    expect(handbackRefusal({ kind: 'claim' }, 'impl')).toBeNull()
  })
})

describe('helpers', () => {
  it('the vocabulary covers every stage mode, and refresh shares escalated with revise', () => {
    expect(Object.keys(HANDBACK_TOKENS).sort()).toEqual(['impl', 'plan', 'refresh', 'review', 'revise'])
    expect(HANDBACK_TOKENS.refresh).toContain('escalated')
  })

  it('refresh mode follows the refreshBranch trigger', () => {
    expect(stageModeFor('revise', 'refreshBranch')).toBe('refresh')
    expect(stageModeFor('revise', 'needsRevision')).toBe('revise')
    expect(stageModeFor('impl', 'planApproved')).toBe('impl')
  })

  it('plan and impl write issues, the rest pull requests, and every mode has a stage', () => {
    expect(['plan', 'impl', 'review', 'revise', 'refresh'].map((mode) => itemKindFor(mode as StageMode))).toEqual(['issue', 'issue', 'pull-request', 'pull-request', 'pull-request'])
    expect(['plan', 'impl', 'review', 'revise', 'refresh'].map((mode) => stageOfMode(mode as StageMode))).toEqual(['plan', 'implement', 'review', 'revise', 'refresh'])
  })

  it('pullRequestNumberOf accepts #n and n only', () => {
    expect(pullRequestNumberOf('#12')).toBe(12)
    expect(pullRequestNumberOf('12')).toBe(12)
    expect(pullRequestNumberOf('#0')).toBeNull()
    expect(pullRequestNumberOf('#12 more')).toBeNull()
    expect(pullRequestNumberOf(null)).toBeNull()
  })

  it('eventWrites skips the outcomes that wait for the session or for Resume', () => {
    const outcome = (kind: Extract<StageEvent, { kind: 'outcome' }>['outcome'], mode: StageMode) => eventWrites({ kind: 'outcome', outcome: kind, handback: null, plan: null }, mode)
    expect([outcome('questions', 'impl'), outcome('interrupted', 'impl'), outcome('usage-limit', 'impl'), outcome('blocked', 'review')]).toEqual([false, false, false, false])
    expect([outcome('blocked', 'impl'), outcome('completed', 'plan'), outcome('error', 'plan')]).toEqual([true, true, true])
  })
})
