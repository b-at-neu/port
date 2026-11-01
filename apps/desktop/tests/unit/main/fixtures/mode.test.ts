import { describe, expect, it } from 'vitest'
import { FIXTURE_ENV, fixtureMode } from '@/main/fixtures/mode'

const isAbsolutePosix = (path: string): boolean => path.startsWith('/')

const DEV = { compiled: true, packaged: false }
const SMOKE = { compiled: true, packaged: true }
const RELEASE = { compiled: false, packaged: false }

describe('fixtureMode', () => {
  it('is off when the flag is unset', () => {
    expect(fixtureMode({}, false, DEV, isAbsolutePosix)).toEqual({ kind: 'off' })
  })

  it('is off when the flag is "true" rather than "1"', () => {
    expect(fixtureMode({ [FIXTURE_ENV.flag]: 'true' }, false, DEV, isAbsolutePosix)).toEqual({ kind: 'off' })
  })

  it('is off when the flag is "0"', () => {
    expect(fixtureMode({ [FIXTURE_ENV.flag]: '0' }, false, DEV, isAbsolutePosix)).toEqual({ kind: 'off' })
  })

  it('is ignored in a packaged build, even with the flag set', () => {
    expect(fixtureMode({ [FIXTURE_ENV.flag]: '1', [FIXTURE_ENV.userData]: '/tmp/fixtures' }, true, DEV, isAbsolutePosix)).toEqual({ kind: 'ignored' })
  })

  it('is ignored in a packaged build that carries fixtures but does not honour the flag', () => {
    expect(fixtureMode({ [FIXTURE_ENV.flag]: '1', [FIXTURE_ENV.userData]: '/tmp/fixtures' }, true, { compiled: true, packaged: false }, isAbsolutePosix)).toEqual({ kind: 'ignored' })
  })

  it('is ignored in a packaged release build', () => {
    expect(fixtureMode({ [FIXTURE_ENV.flag]: '1', [FIXTURE_ENV.userData]: '/tmp/fixtures' }, true, RELEASE, isAbsolutePosix)).toEqual({ kind: 'ignored' })
  })

  it('is invalid in an unpackaged build that carries no fixtures', () => {
    expect(fixtureMode({ [FIXTURE_ENV.flag]: '1', [FIXTURE_ENV.userData]: '/tmp/fixtures' }, false, RELEASE, isAbsolutePosix)).toEqual({
      kind: 'invalid',
      reason: 'PORT_FIXTURES is set but this build carries no fixtures — use `pnpm dev`, or build with `--mode fixtures`',
    })
  })

  it('is invalid when userData is missing', () => {
    const result = fixtureMode({ [FIXTURE_ENV.flag]: '1' }, false, DEV, isAbsolutePosix)
    expect(result.kind).toBe('invalid')
  })

  it('is invalid when userData is empty', () => {
    const result = fixtureMode({ [FIXTURE_ENV.flag]: '1', [FIXTURE_ENV.userData]: '' }, false, DEV, isAbsolutePosix)
    expect(result.kind).toBe('invalid')
  })

  it('is invalid when userData is relative', () => {
    const result = fixtureMode({ [FIXTURE_ENV.flag]: '1', [FIXTURE_ENV.userData]: 'relative/dir' }, false, DEV, isAbsolutePosix)
    expect(result.kind).toBe('invalid')
  })

  it('is on with an absolute userData in an unpackaged build, defaulting to the populated scenario', () => {
    expect(fixtureMode({ [FIXTURE_ENV.flag]: '1', [FIXTURE_ENV.userData]: '/tmp/fixtures' }, false, DEV, isAbsolutePosix)).toEqual({ kind: 'on', userData: '/tmp/fixtures', scenario: 'populated' })
  })

  it('is on with the empty scenario when requested', () => {
    expect(fixtureMode({ [FIXTURE_ENV.flag]: '1', [FIXTURE_ENV.userData]: '/tmp/fixtures', [FIXTURE_ENV.scenario]: 'empty' }, false, DEV, isAbsolutePosix)).toEqual({
      kind: 'on',
      userData: '/tmp/fixtures',
      scenario: 'empty',
    })
  })

  it('is invalid when the scenario is unrecognised', () => {
    const result = fixtureMode({ [FIXTURE_ENV.flag]: '1', [FIXTURE_ENV.userData]: '/tmp/fixtures', [FIXTURE_ENV.scenario]: 'bogus' }, false, DEV, isAbsolutePosix)
    expect(result.kind).toBe('invalid')
  })

  it('is on in a packaged build when the build honours the flag packaged', () => {
    expect(fixtureMode({ [FIXTURE_ENV.flag]: '1', [FIXTURE_ENV.userData]: '/tmp/fixtures' }, true, SMOKE, isAbsolutePosix)).toEqual({ kind: 'on', userData: '/tmp/fixtures', scenario: 'populated' })
  })

  it('is invalid in a packaged build that honours the flag but has no userData', () => {
    const result = fixtureMode({ [FIXTURE_ENV.flag]: '1' }, true, SMOKE, isAbsolutePosix)
    expect(result.kind).toBe('invalid')
  })

  it('is off in a packaged build that honours the flag but the flag is unset', () => {
    expect(fixtureMode({}, true, SMOKE, isAbsolutePosix)).toEqual({ kind: 'off' })
  })
})
