import { describe, expect, it } from 'vitest'
import { gateAnswer } from '@/main/features/gate/actions/answer'
import { callAction } from '../../../support/context'
import { operatorRig, recordingWatcher, REPO_ID, type OperatorRigOptions } from '../../../support/operator-rig'
import { ticketOf } from '../../../support/tickets'

const BODY = 'Ticket body.\n\n## Implementation Plan\n\nPlan text.'
const atPlanReview = ticketOf({ repo: REPO_ID, ticket: 148, stage: 'plan', status: { kind: 'waiting-on-you', gate: 'plan-approval', detail: '' } })
const GATE: OperatorRigOptions = { viewer: 'alice', items: [{ number: 148, title: 'E3 · Plan review gate', labels: ['port', 'plan review'], assignees: [], body: BODY }], tickets: [atPlanReview] }
const approve = { repoId: REPO_ID, number: 148, decision: 'approve' as const, feedback: null, skipComment: false }

describe('gate.answer input', () => {
  it.each([
    { name: 'approve with no feedback', input: approve, ok: true },
    { name: 'request-changes with feedback', input: { ...approve, decision: 'request-changes', feedback: 'rework it' }, ok: true },
    { name: 'request-changes with no feedback', input: { ...approve, decision: 'request-changes' }, ok: false },
    { name: 'request-changes with blank feedback', input: { ...approve, decision: 'request-changes', feedback: '  ' }, ok: false },
    { name: 'request-changes with no feedback, skipping the comment', input: { ...approve, decision: 'request-changes', skipComment: true }, ok: true },
  ])('$name', ({ input, ok }) => {
    expect(gateAnswer.input.safeParse(input).success).toBe(ok)
  })
})

describe('gate actions', () => {
  it('preflight resolves an answerable item', async () => {
    const rig = await operatorRig(GATE)
    expect(await callAction(rig.ctx, 'gate.preflight', { repoId: REPO_ID, number: 148 })).toMatchObject({ kind: 'resolved', verdict: { kind: 'answerable' } })
  })

  it('an applied approve records one github refresh and moves the ticket', async () => {
    const { live, refreshes } = recordingWatcher()
    const rig = await operatorRig({ ...GATE, live })
    expect(await callAction(rig.ctx, 'gate.answer', approve)).toMatchObject({ kind: 'answered', labels: { kind: 'applied' } })
    expect(refreshes).toEqual([{ repoId: REPO_ID, source: 'github' }])
    expect(rig.ticket(148)).toMatchObject({ rev: 1, stage: 'implement' })
  })

  it('a refusal records no refresh', async () => {
    const { live, refreshes } = recordingWatcher()
    const rig = await operatorRig({ ...GATE, tickets: [ticketOf({ repo: REPO_ID, ticket: 148, stage: 'implement' })], live })
    expect(await callAction(rig.ctx, 'gate.answer', approve)).toMatchObject({ kind: 'refused' })
    expect(refreshes).toEqual([])
  })

  it('still returns answered when the refresh throws', async () => {
    const { live } = recordingWatcher({ failRefresh: true })
    const rig = await operatorRig({ ...GATE, live })
    expect(await callAction(rig.ctx, 'gate.answer', approve)).toMatchObject({ kind: 'answered', labels: { kind: 'applied' } })
  })
})
