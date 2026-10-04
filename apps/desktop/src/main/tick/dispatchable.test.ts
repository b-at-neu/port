import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../shared/repos'
import type { TickActionable, TickObservation, TickReport } from '../../shared/tick/types'
import { dispatchableFrom, observableFrom } from './dispatchable'

const ACTIONABLE: TickActionable = { number: 1, kind: 'issue', trigger: 'planApproved', agent: 'impl', unchecked: false, cycle: null }
const WRITE_OBSERVATION: TickObservation = { kind: 'zero-diff', number: 2, itemKind: 'pull-request', count: 3, headRefOid: 'abc123' }
const DEFERRED_OBSERVATION: TickObservation = { kind: 'refresh-deferred', number: 3, itemKind: 'pull-request' }

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
    observations: [WRITE_OBSERVATION, DEFERRED_OBSERVATION],
    ...overrides,
  }
}

describe('dispatchableFrom', () => {
  it('returns the report\'s own actionable set when dispatching and the tick is not blind', () => {
    expect(dispatchableFrom(report(), 'dispatching')).toEqual([ACTIONABLE])
  })

  it('returns nothing while draining', () => {
    expect(dispatchableFrom(report(), 'draining')).toEqual([])
  })

  it('returns nothing while paused', () => {
    expect(dispatchableFrom(report(), 'paused')).toEqual([])
  })

  it('returns nothing for a blind report even while dispatching', () => {
    expect(dispatchableFrom(report({ blind: { reason: 'not-ready' }, actionable: [] }), 'dispatching')).toEqual([])
  })
})

describe('observableFrom', () => {
  it('returns only the write-bearing observations when dispatching and the tick is not blind', () => {
    expect(observableFrom(report(), 'dispatching')).toEqual([WRITE_OBSERVATION])
  })

  it('returns nothing while draining', () => {
    expect(observableFrom(report(), 'draining')).toEqual([])
  })

  it('returns nothing while paused', () => {
    expect(observableFrom(report(), 'paused')).toEqual([])
  })

  it('returns nothing for a blind report even while dispatching', () => {
    expect(observableFrom(report({ blind: { reason: 'not-ready' }, observations: [] }), 'dispatching')).toEqual([])
  })
})
