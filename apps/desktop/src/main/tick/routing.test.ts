import { describe, expect, it } from 'vitest'
import labels from '../../../../../plugins/port/data/labels.json'
import { AGENT_FOR_IN_FLIGHT, AGENT_FOR_TRIGGER, REFRESH_PAIR } from './routing'

describe('AGENT_FOR_TRIGGER', () => {
  it('has exactly one entry per trigger-role label key, both directions', () => {
    const triggerKeys = labels.labels.filter((l) => l.role === 'trigger').map((l) => l.key).sort()
    expect(Object.keys(AGENT_FOR_TRIGGER).sort()).toEqual(triggerKeys)
  })

  it('routes the two revise triggers and the sole plan/impl/review ones correctly', () => {
    expect(AGENT_FOR_TRIGGER.ready).toBe('plan')
    expect(AGENT_FOR_TRIGGER.planChangesRequested).toBe('plan')
    expect(AGENT_FOR_TRIGGER.planApproved).toBe('impl')
    expect(AGENT_FOR_TRIGGER.readyForReview).toBe('review')
    expect(AGENT_FOR_TRIGGER.needsRevision).toBe('revise')
    expect(AGENT_FOR_TRIGGER.refreshBranch).toBe('revise')
  })
})

describe('AGENT_FOR_IN_FLIGHT', () => {
  it('has exactly one entry per in-flight-role label key, both directions', () => {
    const inFlightKeys = labels.labels.filter((l) => l.role === 'in-flight').map((l) => l.key).sort()
    expect(Object.keys(AGENT_FOR_IN_FLIGHT).sort()).toEqual(inFlightKeys)
  })

  it('routes every in-flight key to the stage agent that dispatched it', () => {
    expect(AGENT_FOR_IN_FLIGHT.planning).toBe('plan')
    expect(AGENT_FOR_IN_FLIGHT.inProgress).toBe('impl')
    expect(AGENT_FOR_IN_FLIGHT.reviewing).toBe('review')
    expect(AGENT_FOR_IN_FLIGHT.revising).toBe('revise')
    expect(AGENT_FOR_IN_FLIGHT.refreshing).toBe('revise')
  })
})

describe('REFRESH_PAIR', () => {
  it('names exactly refreshBranch and refreshing', () => {
    expect([...REFRESH_PAIR].sort()).toEqual(['refreshBranch', 'refreshing'])
  })
})
