import { describe, expect, it } from 'vitest'
import labels from '../../../../../plugins/port/templates/labels.json'
import { AGENT_FOR_TRIGGER } from './routing'

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
