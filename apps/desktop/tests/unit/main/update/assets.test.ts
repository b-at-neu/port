import { describe, expect, it } from 'vitest'
import { installTargetOf, openModeOf, pickAsset } from '@/main/update/assets'
import type { AvailableRelease, InstallTarget, ReleaseAsset } from '@/types/update'

const REPO = 'acme/port'
const BASE = `https://github.com/${REPO}/releases/download/v1.4.2/`

function asset(name: string, url = `${BASE}${name}`): ReleaseAsset {
  return { name, url, size: 1000, contentType: null }
}

const NAMES = [
  'port-1.4.2-mac-arm64.dmg',
  'port-1.4.2-mac-arm64.dmg.blockmap',
  'port-1.4.2-mac-x64.dmg',
  'port-1.4.2-mac-x64.dmg.blockmap',
  'port-1.4.2-win-x64.exe',
  'port-1.4.2-win-x64.exe.blockmap',
  'port-1.4.2-linux-x86_64.AppImage',
  'port-1.4.2-linux-amd64.deb',
  'latest.yml',
  'latest-mac.yml',
  'latest-linux.yml',
]

function releaseOf(assets: readonly ReleaseAsset[], version = '1.4.2'): AvailableRelease {
  return { version, tag: `v${version}`, notesUrl: 'https://example.test/notes', publishedAt: null, assets }
}

const RELEASE = releaseOf(NAMES.map((name) => asset(name)))

const input = (platform: string, arch: string, extra: { appImage?: string; arm64Translation?: boolean } = {}) => ({
  platform,
  arch,
  appImage: extra.appImage,
  arm64Translation: extra.arm64Translation ?? false,
})

describe('installTargetOf', () => {
  it.each<[string, ReturnType<typeof input>, InstallTarget | null]>([
    ['mac arm64', input('darwin', 'arm64'), { os: 'mac', arch: 'arm64', package: 'dmg' }],
    ['mac x64', input('darwin', 'x64'), { os: 'mac', arch: 'x64', package: 'dmg' }],
    ['mac x64 under Rosetta', input('darwin', 'x64', { arm64Translation: true }), { os: 'mac', arch: 'arm64', package: 'dmg' }],
    ['windows x64', input('win32', 'x64'), { os: 'win', arch: 'x64', package: 'nsis' }],
    ['windows arm64', input('win32', 'arm64'), { os: 'win', arch: 'arm64', package: 'nsis' }],
    ['linux AppImage x64', input('linux', 'x64', { appImage: '/home/me/port.AppImage' }), { os: 'linux', arch: 'x64', package: 'appimage' }],
    ['linux AppImage arm64', input('linux', 'arm64', { appImage: '/home/me/port.AppImage' }), { os: 'linux', arch: 'arm64', package: 'appimage' }],
    ['linux deb x64', input('linux', 'x64'), { os: 'linux', arch: 'x64', package: 'deb' }],
    ['linux deb arm64', input('linux', 'arm64'), { os: 'linux', arch: 'arm64', package: 'deb' }],
    ['an empty APPIMAGE', input('linux', 'x64', { appImage: '' }), { os: 'linux', arch: 'x64', package: 'deb' }],
    ['a relative APPIMAGE', input('linux', 'x64', { appImage: 'port.AppImage' }), { os: 'linux', arch: 'x64', package: 'deb' }],
    ['ia32', input('win32', 'ia32'), null],
    ['freebsd', input('freebsd', 'x64'), null],
  ])('maps %s', (_label, given, expected) => {
    expect(installTargetOf(given)).toEqual(expected)
  })
})

describe('pickAsset', () => {
  it.each<[InstallTarget, string]>([
    [{ os: 'mac', arch: 'arm64', package: 'dmg' }, 'port-1.4.2-mac-arm64.dmg'],
    [{ os: 'mac', arch: 'x64', package: 'dmg' }, 'port-1.4.2-mac-x64.dmg'],
    [{ os: 'win', arch: 'x64', package: 'nsis' }, 'port-1.4.2-win-x64.exe'],
    [{ os: 'win', arch: 'arm64', package: 'nsis' }, 'port-1.4.2-win-x64.exe'],
    [{ os: 'linux', arch: 'x64', package: 'appimage' }, 'port-1.4.2-linux-x86_64.AppImage'],
    [{ os: 'linux', arch: 'x64', package: 'deb' }, 'port-1.4.2-linux-amd64.deb'],
  ])('picks the one installer for %j, never a blockmap or update metadata', (target, expected) => {
    expect(pickAsset(RELEASE, target, REPO)?.name).toBe(expected)
  })

  it('prefers a native Windows Arm build over the x64 one', () => {
    const release = releaseOf([asset('port-1.4.2-win-x64.exe'), asset('port-1.4.2-win-arm64.exe')])
    expect(pickAsset(release, { os: 'win', arch: 'arm64', package: 'nsis' }, REPO)?.name).toBe('port-1.4.2-win-arm64.exe')
  })

  it('finds nothing for a target the release has no asset for', () => {
    expect(pickAsset(RELEASE, { os: 'linux', arch: 'arm64', package: 'deb' }, REPO)).toBeNull()
    expect(pickAsset(RELEASE, { os: 'linux', arch: 'arm64', package: 'appimage' }, REPO)).toBeNull()
  })

  it('finds nothing when the asset name carries another version', () => {
    const stale = releaseOf(NAMES.map((name) => asset(name)), '1.5.0')
    expect(pickAsset(stale, { os: 'mac', arch: 'arm64', package: 'dmg' }, REPO)).toBeNull()
  })

  it('skips an asset served from outside the repository release downloads', () => {
    const foreign = releaseOf([asset('port-1.4.2-mac-arm64.dmg', 'https://evil.test/acme/port/releases/download/v1.4.2/port-1.4.2-mac-arm64.dmg')])
    expect(pickAsset(foreign, { os: 'mac', arch: 'arm64', package: 'dmg' }, REPO)).toBeNull()
    expect(pickAsset(RELEASE, { os: 'mac', arch: 'arm64', package: 'dmg' }, 'other/repo')).toBeNull()
  })
})

describe('openModeOf', () => {
  it.each<[InstallTarget['os'], InstallTarget['package'], 'open' | 'reveal']>([
    ['mac', 'dmg', 'open'],
    ['win', 'nsis', 'open'],
    ['linux', 'deb', 'open'],
    ['linux', 'appimage', 'reveal'],
  ])('%s %s is %s', (os, pkg, expected) => {
    expect(openModeOf({ os, arch: 'x64', package: pkg })).toBe(expected)
  })
})
