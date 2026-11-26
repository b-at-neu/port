import { describe, expect, it } from 'vitest'
import { classifyGate } from '@/main/pipeline/gate/classify'
import type { GateClassifyItem } from '@/types/gate'
import { queuedAt, ticketAt } from '../../../support/tickets'

const AT_GATE = ticketAt('plan', { kind: 'waiting-on-you', gate: 'plan-approval', detail: '' })

function item(overrides: Partial<GateClassifyItem> = {}): GateClassifyItem {
  return { kind: 'issue', number: 148, ticket: AT_GATE, assignees: [], viewer: 'alice', noPlanBlock: false, ...overrides }
}

describe('classifyGate', () => {
  it('reports not-found for a null item', () => {
    expect(classifyGate({ item: null })).toEqual({ kind: 'not-found' })
  })

  it('reports not-an-issue for a pull request', () => {
    expect(classifyGate({ item: item({ kind: 'pull-request' }) })).toEqual({ kind: 'not-an-issue' })
  })

  it('reports not-at-plan-review with the observed stage name when the ticket is elsewhere', () => {
    const result = classifyGate({ item: item({ ticket: ticketAt('implement', queuedAt()) }) })
    expect(result.kind).toBe('not-at-plan-review')
    expect(result).not.toMatchObject({ observed: null })
  })

  it('reports not-at-plan-review with no observation when there is no ticket', () => {
    expect(classifyGate({ item: item({ ticket: null }) })).toEqual({ kind: 'not-at-plan-review', observed: null })
  })

  it('reports not-at-plan-review when the plan is waiting on a different gate', () => {
    const ticket = ticketAt('plan', { kind: 'waiting-on-you', gate: 'escalation', detail: '' })
    expect(classifyGate({ item: item({ ticket }) }).kind).toBe('not-at-plan-review')
  })

  it('reports answerable with noPlanBlock and assignedElsewhere carried through', () => {
    const result = classifyGate({ item: item({ assignees: ['bob', 'alice'], noPlanBlock: true }) })
    expect(result).toEqual({ kind: 'answerable', noPlanBlock: true, assignedElsewhere: ['bob'] })
  })

  it('never refuses on assignment alone — assignedElsewhere is advisory, not a refusal', () => {
    expect(classifyGate({ item: item({ assignees: ['bob'], viewer: 'alice' }) }).kind).toBe('answerable')
  })
})
