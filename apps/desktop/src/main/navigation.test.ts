import { describe, expect, it } from 'vitest'
import { shouldOpenExternally } from './navigation'

describe('shouldOpenExternally', () => {
  it('allows https URLs', () => {
    expect(shouldOpenExternally('https://example.com')).toBe(true)
  })

  it('allows http URLs', () => {
    expect(shouldOpenExternally('http://example.com')).toBe(true)
  })

  it('denies file URLs', () => {
    expect(shouldOpenExternally('file:///etc/passwd')).toBe(false)
  })

  it('denies javascript URLs', () => {
    expect(shouldOpenExternally('javascript:alert(1)')).toBe(false)
  })

  it('denies a malformed URL without throwing', () => {
    expect(() => shouldOpenExternally('not a url')).not.toThrow()
    expect(shouldOpenExternally('not a url')).toBe(false)
  })
})
