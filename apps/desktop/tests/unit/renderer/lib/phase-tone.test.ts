import { describe, expect, it } from 'vitest'
import { LABEL_DEFAULTS } from '@/utils/labels/defaults'
import { NEEDS_YOU_TONE, phaseTone } from '@/renderer/lib/phase-tone'

const IDLE = { active: false, waitingOnYou: false, operatorNeeded: false }

describe('phaseTone', () => {
  it('operatorNeeded overrides every phase with the red pulsing tone', () => {
    expect(phaseTone({ ...IDLE, stageKey: 'inProgress', active: true, operatorNeeded: true })).toEqual(NEEDS_YOU_TONE)
    expect(phaseTone({ ...IDLE, stageKey: null, operatorNeeded: true })).toEqual(NEEDS_YOU_TONE)
  })

  it('NEEDS_YOU_TONE is a filled, pulsing dot in the needs-you palette', () => {
    expect(NEEDS_YOU_TONE).toEqual({ palette: 'needs-you', fill: 'active', pulse: true })
  })

  it('no stage is the unstaged grey, never pulsing', () => {
    expect(phaseTone({ ...IDLE, stageKey: null })).toEqual({ palette: 'unstaged', fill: 'active', pulse: false })
  })

  it('a marker key has no phase, so it reads as unstaged', () => {
    expect(phaseTone({ ...IDLE, stageKey: 'marker' }).palette).toBe('unstaged')
  })

  it('a queued trigger is a ring, an active one filled', () => {
    expect(phaseTone({ ...IDLE, stageKey: 'planApproved' })).toEqual({ palette: 'implement', fill: 'queued', pulse: false })
    expect(phaseTone({ ...IDLE, stageKey: 'planApproved', active: true })).toEqual({ palette: 'implement', fill: 'active', pulse: false })
  })

  it('an in-flight, gate or terminal key is filled even when not active', () => {
    expect(phaseTone({ ...IDLE, stageKey: 'inProgress' }).fill).toBe('active')
    expect(phaseTone({ ...IDLE, stageKey: 'planReview' }).fill).toBe('active')
    expect(phaseTone({ ...IDLE, stageKey: 'approved' }).fill).toBe('active')
  })

  it('waitingOnYou pulses in the phase colour, not red', () => {
    expect(phaseTone({ ...IDLE, stageKey: 'planReview', waitingOnYou: true })).toEqual({ palette: 'plan', fill: 'active', pulse: true })
  })

  it('every non-marker label key resolves to a phase palette', () => {
    for (const label of LABEL_DEFAULTS.filter((l) => l.role !== 'marker')) {
      expect(phaseTone({ ...IDLE, stageKey: label.key }).palette).toBe(label.palette)
    }
  })
})
