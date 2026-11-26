import { describe, expect, it } from 'vitest'
import type { ReconciledItem } from '@/types/state'
import { actionsFor } from '@/utils/actions/plan'
import { ticketViewOf } from '@/utils/pipeline/stages'
import { reconciledItem } from '../../../support/board-snapshot'
import { queuedAt, ticketAt } from '../../../support/tickets'

type Ticket = ReturnType<typeof ticketAt>

const QUEUED = ticketAt('implement', queuedAt())
const PAUSED = ticketAt('implement', { kind: 'held', on: 'paused', detail: '' })
const RUNNING = ticketAt('implement', { kind: 'running', runId: 'run-1' })

function item(ticket: Ticket | null, overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return reconciledItem({ kind: 'issue', number: 148, assignees: [], marked: false, ticket, ...overrides })
}

function actions(ticket: Ticket | null, overrides: Partial<ReconciledItem> = {}, viewer: string | null = 'op', approvalGate = true) {
  return actionsFor({ view: ticket === null ? null : ticketViewOf(ticket), item: item(ticket, overrides), viewer, approvalGate })
}

const NOT_APPLICABLE = { available: false, reason: 'not-applicable' }

describe('actionsFor — pause and resume', () => {
  it('offers pause on a queued ticket and resume on none of it', () => {
    const result = actions(QUEUED)
    expect(result.pause).toEqual({ available: true, plan: { move: { kind: 'pause' }, addAssignees: ['op'] } })
    expect(result.resume).toEqual(NOT_APPLICABLE)
  })

  it('offers resume, and no pause, on a paused ticket', () => {
    const result = actions(PAUSED)
    expect(result.resume).toEqual({ available: true, plan: { move: { kind: 'resume' }, addAssignees: ['op'] } })
    expect(result.pause).toEqual(NOT_APPLICABLE)
  })

  it('offers pause on a ticket held for another reason, which is not a pause', () => {
    const held = ticketAt('review', { kind: 'held', on: 'checks', detail: '' })
    const result = actions(held)
    expect(result.pause.available).toBe(true)
    expect(result.resume).toEqual(NOT_APPLICABLE)
  })

  it('is not-applicable when the ticket is running, waiting or absent', () => {
    for (const ticket of [RUNNING, ticketAt('plan', { kind: 'waiting-on-you', gate: 'plan-approval', detail: '' }), null]) {
      expect(actions(ticket).pause).toEqual(NOT_APPLICABLE)
      expect(actions(ticket).resume).toEqual(NOT_APPLICABLE)
    }
  })
})

describe('actionsFor — retry and stop', () => {
  it('offers both on a running ticket, adding no assignee when the viewer already owns it', () => {
    const result = actions(RUNNING, { assignees: ['op'] })
    expect(result.retry).toEqual({ available: true, plan: { move: { kind: 'retry' }, addAssignees: [] } })
    expect(result.stop).toEqual({ available: true, plan: { move: { kind: 'stop' }, addAssignees: [] } })
  })

  it('is not-applicable on a queued ticket', () => {
    expect(actions(QUEUED).retry).toEqual(NOT_APPLICABLE)
    expect(actions(QUEUED).stop).toEqual(NOT_APPLICABLE)
  })

  it('refuses not-owned when assigned to someone else', () => {
    expect(actions(RUNNING, { assignees: ['other'] }).stop).toEqual({ available: false, reason: 'not-owned' })
  })
})

describe('actionsFor — gate', () => {
  const pr = (overrides: Partial<ReconciledItem> = {}) => ({ kind: 'pull-request' as const, stages: [{ key: 'reviewing' as const, name: 'reviewing', role: 'in-flight' as const }], ...overrides })

  it('is offered on an ungated pull request regardless of assignee', () => {
    expect(actions(RUNNING, pr({ assignees: ['someone-else'] })).gate).toEqual({ available: true, plan: { move: null, addAssignees: [] } })
  })

  it('is not-applicable when approvalGate is false, on an issue, or once marked', () => {
    expect(actions(RUNNING, pr(), 'op', false).gate).toEqual(NOT_APPLICABLE)
    expect(actions(RUNNING, { stages: pr().stages }).gate).toEqual(NOT_APPLICABLE)
    expect(actions(RUNNING, pr({ marked: true })).gate).toEqual(NOT_APPLICABLE)
  })

  it('is available even when viewer is unknown — gate runs no ownership check', () => {
    expect(actions(RUNNING, pr(), null).gate.available).toBe(true)
  })
})

describe('actionsFor — refresh', () => {
  const pr = (overrides: Partial<ReconciledItem> = {}) => ({ kind: 'pull-request' as const, assignees: ['op'], ...overrides })

  it.each([
    ['a pull request queued at review', ticketAt('review', queuedAt())],
    ['a pull request queued at revise', ticketAt('revise', queuedAt('changes-requested'))],
    ['an approved pull request at the merge gate', ticketAt('merge', { kind: 'waiting-on-you', gate: 'merge', detail: '' })],
  ])('is offered on %s', (_name, ticket) => {
    expect(actions(ticket, pr()).refresh).toEqual({ available: true, plan: { move: { kind: 'refresh' }, addAssignees: [] } })
  })

  it.each([
    ['an issue', QUEUED, { kind: 'issue' as const }],
    ['a pull request running', ticketAt('review', { kind: 'running', runId: 'run-1' }), {}],
    ['an escalated pull request', ticketAt('review', { kind: 'waiting-on-you', gate: 'escalation', detail: '' }), {}],
    ['an untracked pull request', null, {}],
  ])('is not-applicable on %s', (_name, ticket, overrides) => {
    expect(actions(ticket, pr(overrides)).refresh).toEqual(NOT_APPLICABLE)
  })

  it('refuses not-owned the same as the other actions', () => {
    expect(actions(ticketAt('review', queuedAt()), pr({ assignees: ['other'] })).refresh).toEqual({ available: false, reason: 'not-owned' })
  })
})

describe('actionsFor — ownership', () => {
  it('refuses every recovery action viewer-unknown when viewer is null', () => {
    const result = actions(QUEUED, {}, null)
    for (const key of ['pause', 'resume', 'retry', 'stop', 'refresh'] as const) expect(result[key]).toEqual({ available: false, reason: 'viewer-unknown' })
  })

  it('allows an unassigned item, adding the viewer as assignee', () => {
    expect(actions(QUEUED).pause).toMatchObject({ available: true, plan: { addAssignees: ['op'] } })
  })

  it('allows an item assigned exactly to the viewer', () => {
    expect(actions(QUEUED, { assignees: ['op'] }).pause).toMatchObject({ available: true, plan: { addAssignees: [] } })
  })

  it('refuses not-owned when assigned to someone else, or to the viewer among several', () => {
    expect(actions(QUEUED, { assignees: ['other'] }).pause).toEqual({ available: false, reason: 'not-owned' })
    expect(actions(QUEUED, { assignees: ['op', 'other'] }).pause).toEqual({ available: false, reason: 'not-owned' })
  })
})
