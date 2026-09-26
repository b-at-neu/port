import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '../labels/vocabulary'
import type { LabelVocabulary } from '../labels/vocabulary'
import { buildGatePlan, classifyGate } from './classify'
import type { GateClassifyItem } from './classify'

const VOCABULARY: LabelVocabulary = resolveVocabulary({})

function item(overrides: Partial<GateClassifyItem> = {}): GateClassifyItem {
  return { kind: 'issue', number: 148, labels: ['plan review'], assignees: [], viewer: 'alice', noPlanBlock: false, ...overrides }
}

describe('classifyGate', () => {
  it('reports not-found for a null item', () => {
    expect(classifyGate({ item: null, vocabulary: VOCABULARY })).toEqual({ kind: 'not-found' })
  })

  it('reports not-an-issue for a pull request', () => {
    expect(classifyGate({ item: item({ kind: 'pull-request' }), vocabulary: VOCABULARY })).toEqual({ kind: 'not-an-issue' })
  })

  it('reports not-at-plan-review with the observed labels when plan review is absent', () => {
    const result = classifyGate({ item: item({ labels: ['in progress'] }), vocabulary: VOCABULARY })
    expect(result).toEqual({ kind: 'not-at-plan-review', observed: ['in progress'] })
  })

  it('reports not-at-plan-review when the plan-gate key does not resolve at all', () => {
    const emptyVocabulary: LabelVocabulary = { labels: [], disabled: ['planReview'], problems: [] }
    const result = classifyGate({ item: item(), vocabulary: emptyVocabulary })
    expect(result).toEqual({ kind: 'not-at-plan-review', observed: ['plan review'] })
  })

  it('reports answerable with noPlanBlock and assignedElsewhere carried through', () => {
    const result = classifyGate({ item: item({ assignees: ['bob', 'alice'], noPlanBlock: true }), vocabulary: VOCABULARY })
    expect(result).toEqual({ kind: 'answerable', noPlanBlock: true, assignedElsewhere: ['bob'] })
  })

  it('never refuses on assignment alone — assignedElsewhere is advisory, not a refusal', () => {
    const result = classifyGate({ item: item({ assignees: ['bob'], viewer: 'alice' }), vocabulary: VOCABULARY })
    expect(result.kind).toBe('answerable')
  })
})

describe('buildGatePlan', () => {
  it('approve: adds planApproved, removes planReview', () => {
    const plan = buildGatePlan('approve')
    expect(plan.add).toEqual(['planApproved'])
    expect(plan.remove).toEqual(['planReview'])
    expect(plan.expect).toEqual({ present: ['planReview'], absent: ['planApproved', 'planChangesRequested'], assignees: { kind: 'any' } })
  })

  it('request-changes: adds planChangesRequested, removes planReview, same precondition shape', () => {
    const plan = buildGatePlan('request-changes')
    expect(plan.add).toEqual(['planChangesRequested'])
    expect(plan.remove).toEqual(['planReview'])
    expect(plan.expect.present).toEqual(['planReview'])
    expect(plan.expect.absent).toEqual(['planApproved', 'planChangesRequested'])
    expect(plan.expect.assignees).toEqual({ kind: 'any' })
  })
})
