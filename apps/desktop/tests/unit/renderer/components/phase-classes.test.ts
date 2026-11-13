import { describe, expect, it } from 'vitest'
import type { PhaseSegment } from '@/types/board'
import { PHASE_DOT_CLASS, PHASE_EDGE_CLASS, PHASE_RULE_CLASS, segmentClass } from '@/renderer/components/phase-classes'

function segment(state: PhaseSegment['state'], palette: PhaseSegment['palette']): PhaseSegment {
  return { phase: 'review', state, palette }
}

describe('kanban class maps', () => {
  const palettes = Object.keys(PHASE_DOT_CLASS)

  it.each(palettes)('draws the %s rule and edge from that palette dot', (palette) => {
    const colour = PHASE_DOT_CLASS[palette as keyof typeof PHASE_DOT_CLASS].replace('bg-', '')
    expect(PHASE_RULE_CLASS[palette as keyof typeof PHASE_RULE_CLASS]).toBe(`border-b-2 border-${colour}`)
    expect(PHASE_EDGE_CLASS[palette as keyof typeof PHASE_EDGE_CLASS]).toBe(`border-l-4 border-l-${colour}`)
  })
})

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
