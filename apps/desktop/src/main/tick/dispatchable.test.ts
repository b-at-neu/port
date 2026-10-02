import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../shared/repos'
import type { TickActionable, TickObservation, TickReport } from '../../shared/tick/types'
import { dispatchableFrom, observableFrom } from './dispatchable'

const ACTIONABLE: TickActionable = { number: 1, kind: 'issue', trigger: 'planApproved', agent: 'impl', unchecked: false, cycle: null }
const WRITE_OBSERVATION: TickObservation = { kind: 'zero-diff', number: 2, itemKind: 'pull-request', count: 3, headRefOid: 'abc123' }
const DEFERRED_OBSERVATION: TickObservation = { kind: 'refresh-deferred', number: 3, itemKind: 'pull-request' }
const UNVERIFIABLE_OBSERVATION: TickObservation = { kind: 'withdraw-unverifiable', number: 4, itemKind: 'pull-request', reason: 'unreadable' }

function report(overrides: Partial<TickReport> = {}): TickReport {
  return {
    repoId: 'repo-a' as RepoId,
    displayName: 'o/a',
    blind: null,
    actionable: [ACTIONABLE],
    held: [],
    claims: [],
    disabledStages: [],
    nextTickAt: '2026-01-01T00:00:00Z',
    observations: [WRITE_OBSERVATION, DEFERRED_OBSERVATION, UNVERIFIABLE_OBSERVATION],
    ...overrides,
  }
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

describe('observableFrom', () => {
  it('returns only the write-bearing observations when the gate is open and the tick is not blind', () => {
    expect(observableFrom(report(), { gate: 'open' })).toEqual([WRITE_OBSERVATION])
  })

  it('returns nothing while draining', () => {
    expect(observableFrom(report(), { gate: 'draining', reason: 'operator', since: '2026-01-01T00:00:00Z' })).toEqual([])
  })

  it('returns nothing for a blind report even when the gate is open', () => {
    expect(observableFrom(report({ blind: { reason: 'not-ready' }, observations: [] }), { gate: 'open' })).toEqual([])
  })
})
