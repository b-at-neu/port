import { describe, expect, it } from 'vitest'
import type { LabelKey } from '@/utils/labels/vocabulary'
import { phaseSegmentsFor } from '@/renderer/board/phase-model'
import { PHASE_KEYS } from '@/types/board'
import type { PhaseKey } from '@/types/board'

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

describe('phaseSegmentsFor palettes', () => {
  function palettesOf(stageKey: LabelKey | null, kind: 'issue' | 'pull-request' = 'issue', merged = false) {
    return phaseSegmentsFor({ stageKey, kind, merged }).map((s) => s.palette)
  }

  it('finished segments take their own phase palette, the current one the stage palette, the rest none', () => {
    expect(palettesOf('inProgress')).toEqual(['plan', 'plan', 'implement', null, null, null])
    expect(palettesOf('revising', 'pull-request')).toEqual(['plan', 'plan', 'implement', 'review', 'revise', null])
  })

  it('the plan-review gate is the plan palette', () => {
    expect(palettesOf('planReview')).toEqual(['plan', 'plan', null, null, null, null])
  })

  it('a refresh stage paints the last segment grey after every earlier phase', () => {
    expect(palettesOf('refreshing', 'pull-request')).toEqual(['plan', 'plan', 'implement', 'review', 'revise', 'refresh'])
  })

  it('a ready-to-merge pull request ends in the done palette', () => {
    expect(palettesOf('approved', 'pull-request')[PHASE_KEYS.indexOf('merge')]).toBe('done')
  })

  it('needs-you replaces the current segment palette only', () => {
    expect(palettesOf('needsHuman', 'issue')).toEqual(['plan', 'plan', 'needs-you', null, null, null])
  })

  it('a merged pull request is every segment done', () => {
    expect(palettesOf('needsRevision', 'pull-request', true)).toEqual(PHASE_KEYS.map(() => 'done'))
  })

  it('an unstaged row has no palette on any segment', () => {
    expect(palettesOf(null)).toEqual(PHASE_KEYS.map(() => null))
  })
})
