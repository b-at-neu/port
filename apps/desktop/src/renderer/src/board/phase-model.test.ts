import { describe, expect, it } from 'vitest'
import type { LabelKey } from '../../../shared/labels/vocabulary'
import { PHASE_KEYS, phaseSegmentsFor } from './phase-model'
import type { PhaseKey } from './phase-model'

function statesOf(stageKey: LabelKey | null, kind: 'issue' | 'pull-request' = 'issue', merged = false) {
  return phaseSegmentsFor({ stageKey, kind, merged }).map((s) => s.state)
}

function phaseOf(phase: PhaseKey) {
  return PHASE_KEYS.indexOf(phase)
}

describe('phaseSegmentsFor', () => {
  const cases: ReadonlyArray<[LabelKey, PhaseKey]> = [
    ['ready', 'plan'],
    ['planning', 'plan'],
    ['planChangesRequested', 'plan'],
    ['planReview', 'planReview'],
    ['planApproved', 'implement'],
    ['inProgress', 'implement'],
    ['readyForReview', 'review'],
    ['reviewing', 'review'],
    ['needsRevision', 'revision'],
    ['revising', 'revision'],
    ['approved', 'merge'],
    ['refreshBranch', 'merge'],
    ['refreshing', 'merge'],
  ]

  it.each(cases)('every stage key maps to its own segment, marked current-working — %s -> %s', (stageKey, phase) => {
    const states = statesOf(stageKey)
    const pos = phaseOf(phase)
    states.forEach((state, index) => {
      if (index < pos) expect(state).toBe('finished')
      else if (index === pos) expect(state).toBe('current-working')
      else expect(state).toBe('pending')
    })
  })

  it('needsHuman marks implement as current-attention for an issue', () => {
    const states = statesOf('needsHuman', 'issue')
    expect(states[phaseOf('implement')]).toBe('current-attention')
    expect(states[phaseOf('plan')]).toBe('finished')
    expect(states[phaseOf('planReview')]).toBe('finished')
    expect(states[phaseOf('review')]).toBe('pending')
  })

  it('needsHuman marks review as current-attention for a pull request', () => {
    const states = statesOf('needsHuman', 'pull-request')
    expect(states[phaseOf('review')]).toBe('current-attention')
    expect(states[phaseOf('implement')]).toBe('finished')
    expect(states[phaseOf('revision')]).toBe('pending')
  })

  it('blocked marks implement as current-attention for an issue, review for a pull request', () => {
    expect(statesOf('blocked', 'issue')[phaseOf('implement')]).toBe('current-attention')
    expect(statesOf('blocked', 'pull-request')[phaseOf('review')]).toBe('current-attention')
  })

  it('a merged pull request is every segment complete, regardless of its last stage', () => {
    const states = statesOf('needsRevision', 'pull-request', true)
    expect(states).toEqual(PHASE_KEYS.map(() => 'complete'))
  })

  it('no stage at all (an unstaged row) is every segment pending', () => {
    expect(statesOf(null)).toEqual(PHASE_KEYS.map(() => 'pending'))
  })

  it('a stage this table does not recognise (prOpened, a terminal hand-off) is every segment pending', () => {
    expect(statesOf('prOpened')).toEqual(PHASE_KEYS.map(() => 'pending'))
  })
})
