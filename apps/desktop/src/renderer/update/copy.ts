// Every string the update UI shows.
import type { UpdateErrorKind, UpdateState } from '@/types/update'

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
