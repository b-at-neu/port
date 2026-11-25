import { describe, expect, it } from 'vitest'
import { E2E_ENV, e2eMode } from '@/main/app/modes/e2e-mode'

const isAbsolutePosix = (path: string): boolean => path.startsWith('/')
const ON = { [E2E_ENV.flag]: '1', [E2E_ENV.userData]: '/tmp/e2e', [E2E_ENV.fake]: '/tmp/fake.mjs' }

describe('e2eMode', () => {
  it('is off when the flag is unset or is not "1"', () => {
    expect(e2eMode({}, false, true, isAbsolutePosix)).toEqual({ kind: 'off' })
    expect(e2eMode({ [E2E_ENV.flag]: 'true' }, false, true, isAbsolutePosix)).toEqual({ kind: 'off' })
  })

  it('is ignored in a packaged build, even with the flag set', () => {
    expect(e2eMode(ON, true, true, isAbsolutePosix)).toEqual({ kind: 'ignored' })
  })

  it('is ignored in a build compiled without the E2E route, even with the flag set', () => {
    expect(e2eMode(ON, false, false, isAbsolutePosix)).toEqual({ kind: 'ignored' })
  })

  it('is invalid when combined with fixture mode', () => {
    expect(e2eMode({ ...ON, PORT_FIXTURES: '1' }, false, true, isAbsolutePosix).kind).toBe('invalid')
  })

  it.each([
    ['userData is missing', { [E2E_ENV.flag]: '1', [E2E_ENV.fake]: '/tmp/fake.mjs' }],
    ['userData is empty', { ...ON, [E2E_ENV.userData]: '' }],
    ['userData is relative', { ...ON, [E2E_ENV.userData]: 'relative/dir' }],
    ['fake is missing', { [E2E_ENV.flag]: '1', [E2E_ENV.userData]: '/tmp/e2e' }],
    ['fake is relative', { ...ON, [E2E_ENV.fake]: 'fake.mjs' }],
  ])('is invalid when %s', (_name, env) => {
    expect(e2eMode(env, false, true, isAbsolutePosix).kind).toBe('invalid')
  })

  it('is on with absolute userData and fake in an unpackaged build that carries the route', () => {
    expect(e2eMode(ON, false, true, isAbsolutePosix)).toEqual({ kind: 'on', userData: '/tmp/e2e' })
  })
})
