import { describe, expect, it } from 'vitest'
import { LABEL_DEFAULTS } from '@/utils/labels/defaults'
import { NEEDS_YOU_TONE, phaseTone } from '@/renderer/lib/phase-tone'
import { viewOfKey } from '@/renderer/lib/ticket-view'
import type { LabelKey } from '@/utils/labels/vocabulary'

const IDLE = { active: false, waitingOnYou: false, operatorNeeded: false }

const viewOf = (key: LabelKey) => viewOfKey(key, 'issue')

describe('phaseTone', () => {
  it('operatorNeeded overrides every phase with the red pulsing tone', () => {
    expect(phaseTone({ ...IDLE, view: viewOf('inProgress'), active: true, operatorNeeded: true })).toEqual(NEEDS_YOU_TONE)
    expect(phaseTone({ ...IDLE, view: null, operatorNeeded: true })).toEqual(NEEDS_YOU_TONE)
  })

  it.each([null, viewOf('marker'), viewOf('prOpened')])('a view with no stage is the unstaged grey, never pulsing (%#)', (view) => {
    expect(phaseTone({ ...IDLE, view })).toEqual({ palette: 'unstaged', fill: 'active', pulse: false })
  })

  it('a queued status is a ring, an active one filled', () => {
    expect(phaseTone({ ...IDLE, view: viewOf('planApproved') })).toEqual({ palette: 'implement', fill: 'queued', pulse: false })
    expect(phaseTone({ ...IDLE, view: viewOf('planApproved'), active: true })).toEqual({ palette: 'implement', fill: 'active', pulse: false })
  })

  it.each(['inProgress', 'planReview', 'approved'] as const)('%s is filled even when not active', (key) => {
    expect(phaseTone({ ...IDLE, view: viewOf(key) }).fill).toBe('active')
  })

  it('waitingOnYou pulses in the phase colour, not red', () => {
    expect(phaseTone({ ...IDLE, view: viewOf('planReview'), waitingOnYou: true })).toEqual({ palette: 'plan', fill: 'active', pulse: true })
  })

  it('every non-marker label key resolves to its label palette', () => {
    for (const label of LABEL_DEFAULTS.filter((l) => l.role !== 'marker' && l.key !== 'prOpened')) {
      expect(phaseTone({ ...IDLE, view: viewOf(label.key) }).palette).toBe(label.palette)
    }
  })
})
