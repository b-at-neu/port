import { describe, expect, it } from 'vitest'
import { chromeSandboxPath, isSandboxHelperConfigured, needsNoSandbox } from '@/main/sandbox'

describe('isSandboxHelperConfigured', () => {
  it('is true only for uid 0 and mode 4755', () => {
    expect(isSandboxHelperConfigured({ uid: 0, mode: 0o4755 })).toBe(true)
  })

  it('is false for a non-root owner', () => {
    expect(isSandboxHelperConfigured({ uid: 1000, mode: 0o4755 })).toBe(false)
  })

  it('is false for a plain-permission file', () => {
    expect(isSandboxHelperConfigured({ uid: 0, mode: 0o755 })).toBe(false)
  })

  it('is false when extra mode bits are set', () => {
    expect(isSandboxHelperConfigured({ uid: 0, mode: 0o6755 })).toBe(false)
  })

  it('is false for a missing or unreadable stat', () => {
    expect(isSandboxHelperConfigured(null)).toBe(false)
  })
})

describe('needsNoSandbox', () => {
  it('is false for a packaged build regardless of platform or stat', () => {
    expect(needsNoSandbox('linux', true, null)).toBe(false)
  })

  it('is false off linux regardless of stat', () => {
    expect(needsNoSandbox('darwin', false, null)).toBe(false)
    expect(needsNoSandbox('win32', false, null)).toBe(false)
  })

  it('is false on linux when the helper is already configured', () => {
    expect(needsNoSandbox('linux', false, { uid: 0, mode: 0o4755 })).toBe(false)
  })

  it('is true on an unpackaged linux build with a misconfigured helper', () => {
    expect(needsNoSandbox('linux', false, null)).toBe(true)
    expect(needsNoSandbox('linux', false, { uid: 1000, mode: 0o755 })).toBe(true)
  })
})

describe('chromeSandboxPath', () => {
  it('resolves to the sibling chrome-sandbox file', () => {
    expect(chromeSandboxPath('/repo/node_modules/electron/dist/electron')).toBe('/repo/node_modules/electron/dist/chrome-sandbox')
  })
})
