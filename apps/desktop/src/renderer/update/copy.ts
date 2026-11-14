// Every string the update UI shows.
import type { InstallPackage, InstallTarget, UpdateDownloadErrorKind, UpdateErrorKind, UpdateState } from '@/types/update'

export const UPDATE_CHECKING = 'Checking for updates…'
export const UPDATE_NOT_CHECKED = 'Not checked yet'
export const UPDATE_UNAVAILABLE = 'Update status unavailable'
export const UPDATE_UP_TO_DATE = 'port is up to date'
export const UPDATE_CHECK_LABEL = 'Check for updates'
export const UPDATE_BUTTON_LABEL = 'Update'
export const UPDATE_NOTES_LABEL = 'Release notes'
export const UPDATE_RETRY_LABEL = 'Try again'

export function updateAvailableTitle(version: string): string {
  return `port ${version} is available`
}

export function updateRailLabel(version: string): string {
  return `Update to port ${version}`
}

export function updateLatestDescription(current: string): string {
  return `${current} is the latest release.`
}

export function updateCurrentDescription(current: string): string {
  return `You're on ${current}.`
}

export const UPDATE_OPEN_PAGE_LABEL = 'Open release page'
export const UPDATE_OPEN_LABEL = 'Open installer'
export const UPDATE_REVEAL_LABEL = 'Show in folder'
export const UPDATE_DOWNLOAD_PROGRESS_LABEL = 'Download progress'

export function updateDownloadingTitle(version: string): string {
  return `Downloading port ${version}`
}

export function updateDownloadedTitle(version: string): string {
  return `port ${version} downloaded`
}

export function updateDownloadingRailLabel(version: string, percent: number | null): string {
  return percent === null ? updateDownloadingTitle(version) : `${updateDownloadingTitle(version)} · ${percent}%`
}

export const UPDATE_READY_HINT: Readonly<Record<InstallPackage, string>> = {
  dmg: 'Drag port into Applications to replace this version, then reopen port.',
  nsis: 'Follow the installer to finish updating.',
  appimage: 'Make the new AppImage executable and run it in place of this one.',
  deb: 'Install it with your software installer, then restart port.',
}

export const UPDATE_OPEN_FAILED_HINT = "port couldn't open the installer, so it's shown in its folder. Open it from there."

export const UPDATE_DOWNLOAD_FAILED_COPY: Readonly<Record<UpdateDownloadErrorKind, (version: string) => string>> = {
  interrupted: (version) => `The download of port ${version} stopped. Check your connection and try again.`,
  incomplete: (version) => `The download of port ${version} was incomplete. Try again.`,
  unavailable: () => "port couldn't start the download. Try again, or get the installer from the release page.",
}

const PLATFORM_LABEL: Readonly<Record<InstallPackage, Readonly<Record<InstallTarget['arch'], string>>>> = {
  dmg: { arm64: 'macOS (Apple silicon)', x64: 'macOS (Intel)' },
  nsis: { arm64: 'Windows (Arm)', x64: 'Windows (x64)' },
  appimage: { arm64: 'Linux AppImage (Arm)', x64: 'Linux AppImage (x64)' },
  deb: { arm64: 'Linux .deb (Arm)', x64: 'Linux .deb (x64)' },
}

export function platformLabel(target: InstallTarget | null): string {
  return target === null ? 'this system' : PLATFORM_LABEL[target.package][target.arch]
}

export function updateNoAssetCopy(version: string, target: InstallTarget | null): string {
  return `There's no port ${version} download for ${platformLabel(target)}. Get it from the release page.`
}

export const UPDATE_ERROR_COPY: Readonly<Record<UpdateErrorKind, string>> = {
  offline: "Couldn't reach GitHub to check for updates. Check your connection and try again.",
  'rate-limited': "GitHub's rate limit is used up. Check for updates again in an hour.",
  malformed: "GitHub's release list couldn't be read. Try again later.",
  unavailable: "GitHub's releases aren't available right now. Try again later.",
}

type DisabledReason = Extract<UpdateState, { kind: 'disabled' }>['reason']

export const UPDATE_DISABLED_COPY: Readonly<Record<DisabledReason, string>> = {
  unpackaged: 'Update checks run only in installed builds.',
  'dev-build': "Development builds don't check for updates.",
  'unparseable-version': "port can't read its own version, so it can't check for updates.",
}
