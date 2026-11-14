// Pure: which release asset fits this install, and how to hand it to the user.
import type { AvailableRelease, InstallTarget, ReleaseAsset } from '@/types/update'

export interface InstallTargetInput {
  readonly platform: string
  readonly arch: string
  /** The `APPIMAGE` environment variable; set only when running from an AppImage. */
  readonly appImage: string | undefined
  /** True when an x64 build runs under Rosetta on Apple silicon. */
  readonly arm64Translation: boolean
}

function archOf(arch: string): InstallTarget['arch'] | null {
  return arch === 'x64' || arch === 'arm64' ? arch : null
}

export function installTargetOf(input: InstallTargetInput): InstallTarget | null {
  const arch = archOf(input.arch)
  if (arch === null) return null
  if (input.platform === 'darwin') return { os: 'mac', arch: input.arm64Translation ? 'arm64' : arch, package: 'dmg' }
  if (input.platform === 'win32') return { os: 'win', arch, package: 'nsis' }
  if (input.platform === 'linux') {
    const appImage = input.appImage ?? ''
    return { os: 'linux', arch, package: appImage.startsWith('/') ? 'appimage' : 'deb' }
  }
  return null
}

function suffixesOf(target: InstallTarget): readonly string[] {
  switch (target.package) {
    case 'dmg':
      return [`-mac-${target.arch}.dmg`]
    case 'nsis':
      return target.arch === 'arm64' ? ['-win-arm64.exe', '-win-x64.exe'] : ['-win-x64.exe']
    case 'appimage':
      return [target.arch === 'arm64' ? '-linux-arm64.AppImage' : '-linux-x86_64.AppImage']
    case 'deb':
      return [target.arch === 'arm64' ? '-linux-arm64.deb' : '-linux-amd64.deb']
  }
}

/** An asset served from outside the repository's own release downloads is never a candidate. */
export function pickAsset(release: AvailableRelease, target: InstallTarget, repo: string): ReleaseAsset | null {
  const prefix = `https://github.com/${repo}/releases/download/`
  for (const suffix of suffixesOf(target)) {
    const name = `port-${release.version}${suffix}`
    const asset = release.assets.find((candidate) => candidate.name === name && candidate.url.startsWith(prefix))
    if (asset !== undefined) return asset
  }
  return null
}

/** An AppImage is not executable once downloaded, so it is shown in its folder rather than opened. */
export function openModeOf(target: InstallTarget): 'open' | 'reveal' {
  return target.package === 'appimage' ? 'reveal' : 'open'
}
