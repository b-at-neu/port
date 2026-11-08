import { describe, expect, it } from 'vitest'
import { bumpOptions, normalizeVersion, parseVersion, stripPrerelease } from '@/utils/release/version'

describe('parseVersion', () => {
  it.each([
    ['1.4.3', { major: 1, minor: 4, patch: 3, prerelease: null }],
    ['v0.2.0', { major: 0, minor: 2, patch: 0, prerelease: null }],
    ['1.5.0-beta.1', { major: 1, minor: 5, patch: 0, prerelease: 'beta.1' }],
  ])('parses %s', (text, expected) => {
    expect(parseVersion(text)).toEqual(expected)
  })

  it.each(['', '1.4', '1.4.x', 'release-1', '1.4.3.1', '1.4.3-', 'v v1.0.0'])('returns null for %j rather than guessing', (text) => {
    expect(parseVersion(text)).toBeNull()
  })

  it('normalizes and strips a prerelease suffix', () => {
    expect(normalizeVersion(' v1.5.0-dev ')).toBe('1.5.0-dev')
    expect(stripPrerelease('1.5.0-dev')).toBe('1.5.0')
    expect(stripPrerelease('nope')).toBeNull()
  })
})

describe('bumpOptions', () => {
  it('offers patch, minor and major from the current version, none preferred', () => {
    expect(bumpOptions('1.4.3')).toEqual([
      { kind: 'patch', version: '1.4.4' },
      { kind: 'minor', version: '1.5.0' },
      { kind: 'major', version: '2.0.0' },
    ])
  })

  it('bumps from the core of a prerelease version', () => {
    expect(bumpOptions('0.9.9').map((option) => option.version)).toEqual(['0.9.10', '0.10.0', '1.0.0'])
  })

  it('returns no options for a malformed current version', () => {
    expect(bumpOptions('not-a-version')).toEqual([])
  })
})
