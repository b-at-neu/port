import { describe, expect, it, vi } from 'vitest'
import { presentWindow, windowPresentation } from '@/main/presentation'

const KINDS = ['off', 'ignored', 'invalid', 'on'] as const

describe('windowPresentation', () => {
  it('shows without focus and unthrottled for a fixture launch', () => {
    expect(windowPresentation({ fixture: 'on', e2e: 'off', platform: 'linux' })).toEqual({ show: 'inactive', backgroundThrottling: false, activationPolicy: null })
  })

  it('shows without focus for an e2e launch', () => {
    expect(windowPresentation({ fixture: 'off', e2e: 'on', platform: 'win32' })).toEqual({ show: 'inactive', backgroundThrottling: false, activationPolicy: null })
  })

  it('keeps the regular activation policy for an e2e launch on macOS', () => {
    expect(windowPresentation({ fixture: 'off', e2e: 'on', platform: 'darwin' }).activationPolicy).toBeNull()
  })

  it('runs a fixture launch as an accessory app on macOS only', () => {
    expect(windowPresentation({ fixture: 'on', e2e: 'off', platform: 'darwin' }).activationPolicy).toBe('accessory')
    expect(windowPresentation({ fixture: 'on', e2e: 'off', platform: 'linux' }).activationPolicy).toBeNull()
    expect(windowPresentation({ fixture: 'on', e2e: 'off', platform: 'win32' }).activationPolicy).toBeNull()
  })

  it('keeps today’s focused presentation unless a mode is exactly on', () => {
    for (const fixture of KINDS) {
      for (const e2e of KINDS) {
        if (fixture === 'on' || e2e === 'on') continue
        expect(windowPresentation({ fixture, e2e, platform: 'darwin' })).toEqual({ show: 'focus', backgroundThrottling: true, activationPolicy: null })
      }
    }
  })
})

describe('presentWindow', () => {
  it('never calls show() on the harness path', () => {
    const window = { show: vi.fn(), showInactive: vi.fn() }
    presentWindow(window, windowPresentation({ fixture: 'on', e2e: 'off', platform: 'linux' }))
    expect(window.showInactive).toHaveBeenCalledTimes(1)
    expect(window.show).not.toHaveBeenCalled()
  })

  it('calls show() on a normal launch', () => {
    const window = { show: vi.fn(), showInactive: vi.fn() }
    presentWindow(window, windowPresentation({ fixture: 'off', e2e: 'off', platform: 'linux' }))
    expect(window.show).toHaveBeenCalledTimes(1)
    expect(window.showInactive).not.toHaveBeenCalled()
  })
})
