import { describe, expect, it } from 'vitest'
import type { ReleaseEntry } from '@/types/release'
import { buildCandidates, normalizeVersion, parseVersion, stripPrerelease } from '@/utils/release/version'

function entry(number: number | null, labels: readonly string[] = []): ReleaseEntry {
  return { number, title: `change ${String(number)}`, labels, dependency: false }
}

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

describe('buildCandidates', () => {
  it('recommends minor first when a ticket is an enhancement, and gives its reason', () => {
    const candidates = buildCandidates('1.4.3', [entry(364, ['enhancement']), entry(367, ['New Feature']), entry(1, ['bug']), entry(null)])
    expect(candidates.map((c) => [c.version, c.kind, c.recommended])).toEqual([
      ['1.5.0', 'minor', true],
      ['1.4.4', 'patch', false],
      ['2.0.0', 'major', false],
    ])
    expect(candidates[0]?.reason).toBe('#364 and #367 are enhancements; the other 2 are fixes and chores')
    expect(candidates[0]?.tickets).toEqual([364, 367])
  })

  it('recommends patch first when nothing is an enhancement', () => {
    const candidates = buildCandidates('1.4.3', [entry(1, ['bug']), entry(2)])
    expect(candidates.map((c) => c.kind)).toEqual(['patch', 'minor', 'major'])
    expect(candidates[0]?.recommended).toBe(true)
  })

  it('never recommends major, and says no breaking-change signal was found', () => {
    const candidates = buildCandidates('0.9.9', [entry(1, ['breaking', 'enhancement'])])
    expect(candidates.find((c) => c.kind === 'major')?.recommended).toBe(false)
    expect(candidates.find((c) => c.kind === 'major')?.reason).toContain('No breaking-change signal found')
  })

  it('returns no candidates for a malformed current version', () => {
    expect(buildCandidates('not-a-version', [])).toEqual([])
  })
})
