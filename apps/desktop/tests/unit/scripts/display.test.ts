import { describe, expect, it } from 'vitest'
import { displayPlan } from '../../../scripts/display.mjs'

describe('displayPlan', () => {
  it('wraps Linux in xvfb whenever xvfb-run exists', () => {
    expect(displayPlan({ platform: 'linux', hasXvfb: true, hasDisplay: false })).toEqual({ kind: 'xvfb' })
    expect(displayPlan({ platform: 'linux', hasXvfb: true, hasDisplay: true })).toEqual({ kind: 'xvfb' })
  })

  it('refuses on Linux with neither xvfb nor a display, naming how to install it', () => {
    const plan = displayPlan({ platform: 'linux', hasXvfb: false, hasDisplay: false })
    expect(plan.kind).toBe('refuse')
    expect(plan.lines).toHaveLength(2)
    expect(plan.lines[0]).toBe('[screenshots] No display and no xvfb-run, so there is nowhere to open the app window.')
    expect(plan.lines[1]).toContain('sudo apt install xvfb')
  })

  it('falls back to the desktop on Linux without xvfb, saying so plainly', () => {
    const plan = displayPlan({ platform: 'linux', hasXvfb: false, hasDisplay: true })
    expect(plan.kind).toBe('desktop')
    expect(plan.lines).toHaveLength(3)
    expect(plan.lines[0]).toBe('[screenshots] xvfb-run not found — the app window will open on your desktop for this run.')
    expect(plan.lines[2]).toContain('sudo apt install xvfb')
    expect(plan.lines[2]).toContain('sudo dnf install xorg-x11-server-Xvfb')
    expect(plan.lines[2]).toContain('sudo pacman -S xorg-server-xvfb')
  })

  it('runs in the background on macOS regardless of xvfb or display', () => {
    for (const hasXvfb of [true, false]) {
      for (const hasDisplay of [true, false]) {
        const plan = displayPlan({ platform: 'darwin', hasXvfb, hasDisplay })
        expect(plan.kind).toBe('desktop')
        expect(plan.lines).toEqual([
          '[screenshots] macOS has no virtual display — the app window opens in the background for this run.',
          '  It takes no focus and shows no Dock icon; it closes when the run finishes.',
        ])
      }
    }
  })

  it('runs in the background on Windows', () => {
    const plan = displayPlan({ platform: 'win32', hasXvfb: false, hasDisplay: false })
    expect(plan.kind).toBe('desktop')
    expect(plan.lines).toEqual([
      '[screenshots] Windows has no virtual display — the app window opens in the background for this run.',
      '  It takes no focus; it closes when the run finishes.',
    ])
  })
})
