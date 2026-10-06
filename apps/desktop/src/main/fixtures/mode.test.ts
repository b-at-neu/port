import { describe, expect, it } from 'vitest'
import { FIXTURE_ENV, fixtureMode } from './mode'

const isAbsolutePosix = (path: string): boolean => path.startsWith('/')

describe('fixtureMode', () => {
  it('is off when the flag is unset', () => {
    expect(fixtureMode({}, false, isAbsolutePosix)).toEqual({ kind: 'off' })
  })

  it('is off when the flag is "true" rather than "1"', () => {
    expect(fixtureMode({ [FIXTURE_ENV.flag]: 'true' }, false, isAbsolutePosix)).toEqual({ kind: 'off' })
  })

  it('is off when the flag is "0"', () => {
    expect(fixtureMode({ [FIXTURE_ENV.flag]: '0' }, false, isAbsolutePosix)).toEqual({ kind: 'off' })
  })

  it('is ignored in a packaged build, even with the flag set', () => {
    expect(fixtureMode({ [FIXTURE_ENV.flag]: '1', [FIXTURE_ENV.userData]: '/tmp/fixtures' }, true, isAbsolutePosix)).toEqual({ kind: 'ignored' })
  })

  it('is invalid when userData is missing', () => {
    const result = fixtureMode({ [FIXTURE_ENV.flag]: '1' }, false, isAbsolutePosix)
    expect(result.kind).toBe('invalid')
  })

  it('is invalid when userData is empty', () => {
    const result = fixtureMode({ [FIXTURE_ENV.flag]: '1', [FIXTURE_ENV.userData]: '' }, false, isAbsolutePosix)
    expect(result.kind).toBe('invalid')
  })

  it('is invalid when userData is relative', () => {
    const result = fixtureMode({ [FIXTURE_ENV.flag]: '1', [FIXTURE_ENV.userData]: 'relative/dir' }, false, isAbsolutePosix)
    expect(result.kind).toBe('invalid')
  })

  it('is on with an absolute userData in an unpackaged build, defaulting to the populated scenario', () => {
    expect(fixtureMode({ [FIXTURE_ENV.flag]: '1', [FIXTURE_ENV.userData]: '/tmp/fixtures' }, false, isAbsolutePosix)).toEqual({ kind: 'on', userData: '/tmp/fixtures', scenario: 'populated' })
  })

  it('is on with the empty scenario when requested', () => {
    expect(fixtureMode({ [FIXTURE_ENV.flag]: '1', [FIXTURE_ENV.userData]: '/tmp/fixtures', [FIXTURE_ENV.scenario]: 'empty' }, false, isAbsolutePosix)).toEqual({
      kind: 'on',
      userData: '/tmp/fixtures',
      scenario: 'empty',
    })
  })

  it('is invalid when the scenario is unrecognised', () => {
    const result = fixtureMode({ [FIXTURE_ENV.flag]: '1', [FIXTURE_ENV.userData]: '/tmp/fixtures', [FIXTURE_ENV.scenario]: 'bogus' }, false, isAbsolutePosix)
    expect(result.kind).toBe('invalid')
  })
})
