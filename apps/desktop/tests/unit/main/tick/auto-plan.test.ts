import { describe, expect, it } from 'vitest'
import type { ReconciledItem } from '@/types/state'
import { autoApprovalsOf } from '@/main/tick/auto-plan'
import { reconciledItem } from '../../../fixtures/board-state'

function item(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return reconciledItem({
    stage: 'trigger',
    stages: [{ key: 'planReview', name: 'plan review', role: 'gate' }],
    autoPlan: true,
    matchedKeys: ['planReview'],
    ...overrides,
  })
}

describe('autoApprovalsOf', () => {
  it('advances an autoPlan issue at planReview alone, assigned to the viewer', () => {
    expect(autoApprovalsOf([item()], 'op')).toEqual([{ number: 1 }])
  })

  it('leaves an issue without autoPlan untouched', () => {
    expect(autoApprovalsOf([item({ autoPlan: false })], 'op')).toEqual([])
  })

  it('leaves a contradictory item (more than one stage label) untouched', () => {
    const contradictory = item({
      stages: [
        { key: 'planReview', name: 'plan review', role: 'gate' },
        { key: 'planApproved', name: 'plan approved', role: 'trigger' },
      ],
    })
    expect(autoApprovalsOf([contradictory], 'op')).toEqual([])
  })

  it('leaves a pull request untouched, even with autoPlan set', () => {
    expect(autoApprovalsOf([item({ kind: 'pull-request' })], 'op')).toEqual([])
  })

  it('leaves an item assigned to someone else untouched', () => {
    expect(autoApprovalsOf([item({ assignees: ['someone-else'] })], 'op')).toEqual([])
  })

  it('leaves an unassigned item untouched', () => {
    expect(autoApprovalsOf([item({ assignees: [] })], 'op')).toEqual([])
  })

  it('still qualifies a session-required item — the cockpit rule is ignored here', () => {
    expect(autoApprovalsOf([item({ sessionRequired: true })], 'op')).toEqual([{ number: 1 }])
  })

  it('returns [] for a null viewer', () => {
    expect(autoApprovalsOf([item()], null)).toEqual([])
  })
})
