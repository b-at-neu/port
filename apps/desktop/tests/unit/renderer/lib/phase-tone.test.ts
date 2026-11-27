import { describe, expect, it } from 'vitest'
import { NEEDS_YOU_TONE, phaseTone } from '@/renderer/lib/phase-tone'
import { STAGE_TABLE, ticketViewOf } from '@/utils/pipeline/stages'
import { queuedAt, ticketAt } from '../../../support/tickets'

const IDLE = { active: false, waitingOnYou: false, operatorNeeded: false }

describe('phaseTone', () => {
  it('operatorNeeded overrides every phase with the red pulsing tone', () => {
    const view = ticketViewOf(ticketAt('implement', { kind: 'running', runId: null }))
    expect(phaseTone({ ...IDLE, view, active: true, operatorNeeded: true })).toEqual(NEEDS_YOU_TONE)
    expect(phaseTone({ ...IDLE, view: null, operatorNeeded: true })).toEqual(NEEDS_YOU_TONE)
  })

  it('no view is the unstaged grey, never pulsing', () => {
    expect(phaseTone({ ...IDLE, view: null })).toEqual({ palette: 'unstaged', fill: 'active', pulse: false })
  })

  it('a queued status is a ring, an active one filled', () => {
    const view = ticketViewOf(ticketAt('implement', queuedAt('new')))
    expect(phaseTone({ ...IDLE, view })).toEqual({ palette: 'implement', fill: 'queued', pulse: false })
    expect(phaseTone({ ...IDLE, view, active: true })).toEqual({ palette: 'implement', fill: 'active', pulse: false })
  })

  it('a running status is filled even when not active', () => {
    expect(phaseTone({ ...IDLE, view: ticketViewOf(ticketAt('plan', { kind: 'running', runId: null })) }).fill).toBe('active')
  })

  it('waitingOnYou pulses in the phase colour, not red', () => {
    const view = ticketViewOf(ticketAt('plan', { kind: 'waiting-on-you', gate: 'plan-approval', detail: '' }))
    expect(phaseTone({ ...IDLE, view, waitingOnYou: true })).toEqual({ palette: 'plan', fill: 'active', pulse: true })
  })

  it('every stage resolves to its table palette', () => {
    for (const stage of ['plan', 'implement', 'review', 'revise', 'refresh', 'merge'] as const) {
      const view = ticketViewOf(ticketAt(stage, { kind: 'running', runId: null }))
      expect(phaseTone({ ...IDLE, view }).palette).toBe(STAGE_TABLE[stage].running.palette)
    }
  })
})
