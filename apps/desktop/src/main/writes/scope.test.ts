import { describe, expect, it } from 'vitest'
import { PLAN_GATE_KEYS, evaluate, scopeFor, wouldChangeNothing } from './scope'

describe('scopeFor', () => {
  it('requires plan-gate when add touches a plan-gate key', () => {
    expect(scopeFor({ add: ['planApproved'], remove: [] })).toBe('plan-gate')
  })

  it('requires plan-gate when remove touches a plan-gate key', () => {
    expect(scopeFor({ add: [], remove: ['planReview'] })).toBe('plan-gate')
  })

  it('requires no scope for a convergent write', () => {
    expect(scopeFor({ add: ['ready'], remove: ['blocked'] })).toBe(null)
  })

  it('requires no scope for an empty request', () => {
    expect(scopeFor({ add: [], remove: [] })).toBe(null)
  })

  it('PLAN_GATE_KEYS excludes autoPlan', () => {
    expect(PLAN_GATE_KEYS).not.toContain('autoPlan')
    expect(scopeFor({ add: ['autoPlan'], remove: [] })).toBe(null)
  })
})

describe('evaluate', () => {
  const base = { presentNames: ['plan review'], absentNames: ['plan approved'], assignees: { kind: 'any' as const } }

  it('is satisfied when present/absent/assignee expectations all hold', () => {
    const observed = { labels: ['plan review'], assignees: [], readAt: '2026-01-01T00:00:00Z' }
    expect(evaluate(base, observed)).toEqual({ satisfied: true })
  })

  it('reports a violation when an expected-present label is missing', () => {
    const observed = { labels: ['plan approved'], assignees: [], readAt: '2026-01-01T00:00:00Z' }
    const verdict = evaluate(base, observed)
    expect(verdict.satisfied).toBe(false)
    if (verdict.satisfied) throw new Error('unreachable')
    expect(verdict.expected).toEqual(['plan review'])
    expect(verdict.observed).toEqual(['plan approved'])
  })

  it('reports a violation when an expected-absent label is present', () => {
    const observed = { labels: ['plan review', 'plan approved'], assignees: [], readAt: '2026-01-01T00:00:00Z' }
    const verdict = evaluate(base, observed)
    expect(verdict.satisfied).toBe(false)
  })

  it('honours an exactly assignee expectation', () => {
    const precondition = { presentNames: [], absentNames: [], assignees: { kind: 'exactly' as const, logins: ['alice'] } }
    const satisfied = evaluate(precondition, { labels: [], assignees: ['alice'], readAt: '2026-01-01T00:00:00Z' })
    expect(satisfied).toEqual({ satisfied: true })
    const violated = evaluate(precondition, { labels: [], assignees: ['bob'], readAt: '2026-01-01T00:00:00Z' })
    expect(violated.satisfied).toBe(false)
  })

  it('honours an unassigned assignee expectation', () => {
    const precondition = { presentNames: [], absentNames: [], assignees: { kind: 'unassigned' as const } }
    expect(evaluate(precondition, { labels: [], assignees: [], readAt: '2026-01-01T00:00:00Z' })).toEqual({ satisfied: true })
    expect(evaluate(precondition, { labels: [], assignees: ['alice'], readAt: '2026-01-01T00:00:00Z' }).satisfied).toBe(false)
  })
})

describe('wouldChangeNothing', () => {
  const observed = { labels: ['ready'], assignees: [], readAt: '2026-01-01T00:00:00Z' }

  it('is true when every add is already present and every remove is already absent', () => {
    expect(wouldChangeNothing({ addNames: ['ready'], removeNames: ['blocked'], addAssignees: [], removeAssignees: [] }, observed)).toBe(true)
  })

  it('is false when an add name is not yet present', () => {
    expect(wouldChangeNothing({ addNames: ['blocked'], removeNames: [], addAssignees: [], removeAssignees: [] }, observed)).toBe(false)
  })

  it('is false whenever an assignee change is requested, even if labels already match', () => {
    expect(wouldChangeNothing({ addNames: ['ready'], removeNames: [], addAssignees: ['alice'], removeAssignees: [] }, observed)).toBe(false)
  })
})
