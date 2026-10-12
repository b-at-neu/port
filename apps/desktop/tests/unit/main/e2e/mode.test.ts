import { describe, expect, it } from 'vitest'
import { E2E_ENV, e2eMode } from '@/main/e2e/mode'

const isAbsolutePosix = (path: string): boolean => path.startsWith('/')

describe('e2eMode', () => {
  it('is off when the flag is unset', () => {
    expect(e2eMode({}, false, isAbsolutePosix)).toEqual({ kind: 'off' })
  })

  it('is off when the flag is "true" rather than "1"', () => {
    expect(e2eMode({ [E2E_ENV.flag]: 'true' }, false, isAbsolutePosix)).toEqual({ kind: 'off' })
  })

  it('is ignored in a packaged build, even with the flag set', () => {
    expect(e2eMode({ [E2E_ENV.flag]: '1', [E2E_ENV.userData]: '/tmp/e2e', [E2E_ENV.fake]: '/tmp/fake.mjs' }, true, isAbsolutePosix)).toEqual({ kind: 'ignored' })
  })

  it('is invalid when combined with fixture mode', () => {
    const result = e2eMode({ [E2E_ENV.flag]: '1', PORT_FIXTURES: '1', [E2E_ENV.userData]: '/tmp/e2e', [E2E_ENV.fake]: '/tmp/fake.mjs' }, false, isAbsolutePosix)
    expect(result.kind).toBe('invalid')
  })

  it('is invalid when userData is missing', () => {
    const result = e2eMode({ [E2E_ENV.flag]: '1', [E2E_ENV.fake]: '/tmp/fake.mjs' }, false, isAbsolutePosix)
    expect(result.kind).toBe('invalid')
  })

  it('is invalid when userData is empty', () => {
    const result = e2eMode({ [E2E_ENV.flag]: '1', [E2E_ENV.userData]: '', [E2E_ENV.fake]: '/tmp/fake.mjs' }, false, isAbsolutePosix)
    expect(result.kind).toBe('invalid')
  })

  it('is invalid when userData is relative', () => {
    const result = e2eMode({ [E2E_ENV.flag]: '1', [E2E_ENV.userData]: 'relative/dir', [E2E_ENV.fake]: '/tmp/fake.mjs' }, false, isAbsolutePosix)
    expect(result.kind).toBe('invalid')
  })

  it('is invalid when fake is missing', () => {
    const result = e2eMode({ [E2E_ENV.flag]: '1', [E2E_ENV.userData]: '/tmp/e2e' }, false, isAbsolutePosix)
    expect(result.kind).toBe('invalid')
  })

  it('is invalid when fake is relative', () => {
    const result = e2eMode({ [E2E_ENV.flag]: '1', [E2E_ENV.userData]: '/tmp/e2e', [E2E_ENV.fake]: 'fake.mjs' }, false, isAbsolutePosix)
    expect(result.kind).toBe('invalid')
  })

  it('is on with absolute userData and fake in an unpackaged build', () => {
    expect(e2eMode({ [E2E_ENV.flag]: '1', [E2E_ENV.userData]: '/tmp/e2e', [E2E_ENV.fake]: '/tmp/fake.mjs' }, false, isAbsolutePosix)).toEqual({
      kind: 'on',
      userData: '/tmp/e2e',
      fake: '/tmp/fake.mjs',
    })
  })
})
