import { describe, expect, it } from 'vitest'
import { checkGate, classifyUpdate, selectLatestRelease } from '@/main/update/select'
import { parseVersion, type ParsedVersion } from '@/utils/release/version'
import type { AppRelease } from '@/types/update'

function release(tag: string, flags: Partial<Pick<AppRelease, 'draft' | 'prerelease'>> = {}): AppRelease {
  return { tag, notesUrl: `https://example.test/${tag}`, draft: false, prerelease: false, publishedAt: null, assets: [], ...flags }
}

function version(text: string): ParsedVersion {
  const parsed = parseVersion(text)
  if (parsed === null) throw new Error(`unparseable fixture: ${text}`)
  return parsed
}

describe('selectLatestRelease', () => {
  it('picks the highest stable tag regardless of list order', () => {
    expect(selectLatestRelease([release('v1.4.0'), release('v1.10.0'), release('v1.9.0')])?.tag).toBe('v1.10.0')
  })

  it('skips drafts, prerelease-flagged releases and prerelease-shaped tags', () => {
    const picked = selectLatestRelease([release('v2.0.0', { draft: true }), release('v1.9.0', { prerelease: true }), release('v1.8.0-rc.1'), release('v1.7.0')])
    expect(picked?.tag).toBe('v1.7.0')
  })

  it('skips tags that do not parse', () => {
    expect(selectLatestRelease([release('nightly'), release('v1.0.0')])?.tag).toBe('v1.0.0')
  })

  it('keeps the first of two equal versions', () => {
    const first = release('v1.2.0')
    const second = release('1.2.0')
    expect(selectLatestRelease([first, second])).toBe(first)
  })

  it('returns null when nothing qualifies', () => {
    expect(selectLatestRelease([])).toBeNull()
    expect(selectLatestRelease([release('v1.0.0', { prerelease: true })])).toBeNull()
  })
})

describe('classifyUpdate', () => {
  it('reports a newer release as available, with its version, notes URL and assets', () => {
    const asset = { name: 'port.dmg', url: 'https://example.test/port.dmg', size: 1, contentType: null }
    const latest = { ...release('v1.5.0'), publishedAt: '2026-01-01T00:00:00Z', assets: [asset] }
    expect(classifyUpdate(version('1.4.2'), latest)).toEqual({
      kind: 'available',
      release: { version: '1.5.0', tag: 'v1.5.0', notesUrl: 'https://example.test/v1.5.0', publishedAt: '2026-01-01T00:00:00Z', assets: [asset] },
    })
  })

  it.each([
    ['equal', '1.5.0', 'v1.5.0'],
    ['running ahead', '1.6.0', 'v1.5.0'],
  ])('is up to date when %s', (_label, current, tag) => {
    expect(classifyUpdate(version(current), release(tag))).toEqual({ kind: 'up-to-date', latest: '1.5.0' })
  })

  it('is up to date with no latest release', () => {
    expect(classifyUpdate(version('1.5.0'), null)).toEqual({ kind: 'up-to-date', latest: null })
  })

  it('offers the stable release of a running prerelease, but not an older one', () => {
    expect(classifyUpdate(version('1.5.0-rc.1'), release('v1.5.0')).kind).toBe('available')
    expect(classifyUpdate(version('1.5.0-rc.1'), release('v1.4.1')).kind).toBe('up-to-date')
  })
})

describe('checkGate', () => {
  it('disables an unpackaged build before anything else', () => {
    expect(checkGate({ isPackaged: false, version: '1.4.0-dev' })).toEqual({ ok: false, reason: 'unpackaged' })
  })

  it.each(['1.4.2-dev', '1.5.0-dev.3'])('disables a packaged dev build %s', (text) => {
    expect(checkGate({ isPackaged: true, version: text })).toEqual({ ok: false, reason: 'dev-build' })
  })

  it('disables an unparseable version', () => {
    expect(checkGate({ isPackaged: true, version: 'garbage' })).toEqual({ ok: false, reason: 'unparseable-version' })
  })

  it('passes the parsed version for a packaged release build', () => {
    expect(checkGate({ isPackaged: true, version: '1.4.2' })).toEqual({ ok: true, current: version('1.4.2') })
  })
})
