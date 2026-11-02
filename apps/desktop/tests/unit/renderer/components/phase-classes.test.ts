import { describe, expect, it } from 'vitest'
import type { PhaseSegment } from '@/types/board'
import { segmentClass } from '@/renderer/components/phase-classes'

function segment(state: PhaseSegment['state'], palette: PhaseSegment['palette']): PhaseSegment {
  return { phase: 'review', state, palette }
}

describe('segmentClass', () => {
  it('paints a finished segment the past neutral whatever its palette', () => {
    expect(segmentClass(segment('finished', 'plan'))).toBe('bg-segment-past')
    expect(segmentClass(segment('finished', 'revise'))).toBe('bg-segment-past')
  })

  it('paints a pending segment the future neutral', () => {
    expect(segmentClass(segment('pending', null))).toBe('bg-segment-future')
  })

  it('paints a merged segment the full done dot', () => {
    expect(segmentClass(segment('complete', 'done'))).toBe('bg-phase-done-dot')
  })

  it('paints the current segment its own palette dot', () => {
    expect(segmentClass(segment('current-working', 'review'))).toBe('bg-phase-review-dot')
    expect(segmentClass(segment('current-attention', 'needs-you'))).toBe('bg-phase-needs-you-dot')
  })
})
