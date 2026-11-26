import { describe, expect, it } from 'vitest'
import type { TickObservation } from '@/types/tick'
import { observationWrite } from '@/main/pipeline/observation'
import type { WriteObservation } from '@/types/dispatch'
import { reconciledItem } from '../../../support/board-snapshot'

const item = (number = 52) => reconciledItem({ number })
const red = [{ name: 'audit', conclusion: 'FAILURE', url: null }]

describe('observationWrite — plan-missing', () => {
  it('sends the plan back with the operator move and a plain comment', () => {
    const observation: WriteObservation = { kind: 'plan-missing', number: 52, itemKind: 'issue' }
    const plan = observationWrite(observation, item(), 'dev')
    expect(plan.move).toEqual({ kind: 'request-plan-changes' })
    expect(plan.action).toBe('observe-plan-missing')
    expect(plan.comment).toContain('## Implementation Plan')
  })
})

describe('observationWrite — withdraw-approval route', () => {
  it('a revise route revises with the plain comment', () => {
    const observation: TickObservation = { kind: 'withdraw-approval', route: 'revise', number: 52, itemKind: 'pull-request', red, headRefOid: 'abc1234' }
    const plan = observationWrite(observation, item(), 'dev')
    expect(plan.move).toEqual({ kind: 'revise' })
    expect(plan.comment).not.toContain('instead of revision')
  })

  it('a human route escalates and says so in the comment', () => {
    const observation: TickObservation = { kind: 'withdraw-approval', route: 'human', number: 52, itemKind: 'pull-request', red, headRefOid: 'abc1234' }
    const plan = observationWrite(observation, item(), 'dev')
    expect(plan.move).toEqual({ kind: 'escalate', detail: 'approval-withdrawn' })
    expect(plan.comment).toMatch(/^## Approval withdrawn\n/)
    expect(plan.comment).toContain('escalated to you instead of revision. A new head is the way past it.')
  })
})

describe('observationWrite — zero-diff observation', () => {
  const observation: TickObservation = { kind: 'zero-diff', number: 52, itemKind: 'pull-request', count: 3, headRefOid: 'abc1234' }

  it('a sha-cap escalation names the head and that a new head is the way past it', () => {
    const plan = observationWrite(observation, item(), 'dev')
    expect(plan.move).toEqual({ kind: 'escalate', detail: 'sha-cap' })
    expect(plan.comment).toContain('Cycle 3 was the second review of `abc1234`, the most one head gets. A new head is the way past it.')
  })

  it('ends the escalation with the sha-cap marker and head', () => {
    expect(observationWrite(observation, item(), 'dev').comment?.endsWith('\n<!-- port:escalation sha-cap abc1234 -->')).toBe(true)
  })
})

describe('observationWrite — escalation markers', () => {
  const pr = reconciledItem({ kind: 'pull-request', number: 52, headRefOid: 'def5678' })

  it('marks the cycle-cap escalation with the item head', () => {
    const observation: TickObservation = { kind: 'cycle-cap', number: 52, itemKind: 'pull-request', count: 5, cap: 5 }
    const plan = observationWrite(observation, pr, 'dev')
    expect(plan.move).toEqual({ kind: 'escalate', detail: 'cycle-cap' })
    expect(plan.comment?.endsWith('\n<!-- port:escalation cycle-cap def5678 -->')).toBe(true)
  })

  it('marks the integration-red escalation with its head', () => {
    const observation: TickObservation = { kind: 'integration-red', number: 52, itemKind: 'pull-request', checks: ['test'], headRefOid: 'abc1234' }
    const plan = observationWrite(observation, pr, 'dev')
    expect(plan.move).toEqual({ kind: 'escalate', detail: 'integration-red' })
    expect(plan.comment?.endsWith('\n<!-- port:escalation integration-red abc1234 -->')).toBe(true)
  })
})

describe('observationWrite — liveness-reset', () => {
  it('retries the stage in place of the stale running status', () => {
    const observation: TickObservation = { kind: 'liveness-reset', number: 52, itemKind: 'issue', stage: 'implement' }
    const plan = observationWrite(observation, item(), 'dev')
    expect(plan.action).toBe('observe-liveness-reset')
    expect(plan.move).toEqual({ kind: 'retry' })
    expect(plan.comment).toBeNull()
  })
})
