import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../shared/repos'
import type { TickActionable, TickReport } from '../../shared/tick/types'
import { dispatchableFrom } from './dispatchable'

const ACTIONABLE: TickActionable = { number: 1, kind: 'issue', trigger: 'planApproved', agent: 'impl', unchecked: false, cycle: null }

function report(overrides: Partial<TickReport> = {}): TickReport {
  return { repoId: 'repo-a' as RepoId, displayName: 'o/a', blind: null, actionable: [ACTIONABLE], held: [], claims: [], disabledStages: [], nextTickAt: '2026-01-01T00:00:00Z', ...overrides }
}

describe('dispatchableFrom', () => {
  it('returns the report\'s own actionable set when the gate is open and the tick is not blind', () => {
    expect(dispatchableFrom(report(), { gate: 'open' })).toEqual([ACTIONABLE])
  })

  it('returns nothing while draining, operator reason', () => {
    expect(dispatchableFrom(report(), { gate: 'draining', reason: 'operator', since: '2026-01-01T00:00:00Z' })).toEqual([])
  })

  it('returns nothing while draining, unread reason', () => {
    expect(dispatchableFrom(report(), { gate: 'draining', reason: 'unread' })).toEqual([])
  })

  it('returns nothing while draining, unreadable reason', () => {
    expect(dispatchableFrom(report(), { gate: 'draining', reason: 'unreadable', message: 'boom', path: '/dispatch.json' })).toEqual([])
  })

  it('returns nothing for a blind report even when the gate is open', () => {
    expect(dispatchableFrom(report({ blind: { reason: 'not-ready' }, actionable: [] }), { gate: 'open' })).toEqual([])
  })
})
