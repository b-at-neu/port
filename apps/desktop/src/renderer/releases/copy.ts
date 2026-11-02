// Every string on the Releases screen.
import type { HookOutcome, PullLink, ReleaseRunResult, ReleaseStatus, VersionCandidate } from '@/types/release'

export const RELEASES_TITLE = 'Releases'
export const NO_REPOSITORIES = 'Register a repository to see its releases.'
export const PREVIOUS_RELEASES = 'Previous releases'
export const NO_RELEASES = 'No releases yet.'
export const DEPENDENCIES_LABEL = 'Dependencies'
export const CUT_RELEASE = 'Cut release'
export const OPEN_RELEASE_PR = 'Open release PR'
export const OPEN_BUMP_PR = 'Open bump PR'
export const OPEN_PR = 'Open PR'
export const OPEN_ON_GITHUB = 'Open on GitHub'
export const WAITING_ON_YOU = 'Waiting on you'
export const NOTES_EMPTY_TOOLTIP = "Notes can't be empty"
export const NOTES_LABEL = 'Release notes'
export const CUSTOM_VERSION_LABEL = 'Custom version…'
export const CUSTOM_VERSION_ERROR = 'Use X.Y.Z, optionally with a prerelease like 1.5.0-beta.1.'
export const NOTES_EMPTY = 'No notes were written for this release.'
export const LATEST_TAG = 'Latest'
export const PRERELEASE_TAG = 'Prerelease'
export const OPENED_TOAST = 'Opened the release pull request.'

export function readFailureCopy(repo: string, message: string): string {
  return `Couldn't read releases for ${repo}: ${message}`
}

export function currentVersionCopy(version: string | null): string | null {
  return version === null ? null : `Current v${version}`
}

export function upcomingLabel(candidates: readonly VersionCandidate[]): string {
  const recommended = candidates.find((candidate) => candidate.recommended)
  return recommended === undefined ? 'Upcoming' : `Upcoming · v${recommended.version} recommended`
}

export function versionOptionLabel(candidate: VersionCandidate): string {
  return `${candidate.version} — ${candidate.kind}${candidate.recommended ? ' (recommended)' : ''}`
}

export function nothingToReleaseCopy(integration: string, current: string | null): string {
  return current === null ? `Nothing to release. ${integration} has no changes to release.` : `Nothing to release. ${integration} has no changes since v${current}.`
}

export function cutDialogBody(status: ReleaseStatus): string {
  const production = status.production ?? 'the production branch'
  const release = `the release PR from ${status.integration} into ${production}`
  return status.versionSource === 'package' ? `This opens a bump PR into ${status.integration}, then ${release}.` : `This opens ${release}.`
}

export function bumpedCopy(integration: string, version: string): string {
  return `${integration} already carries v${version}.`
}

export const WAITING_BUMP_COPY = 'Merge the bump PR first, then the release PR.'

export function waitingMergeCopy(release: PullLink, version: string | null): string {
  return version === null ? `Merge PR#${String(release.number)} to ship this release.` : `Merge PR#${String(release.number)} to ship v${version}.`
}

export function readyToPublishCopy(version: string, production: string): string {
  return `v${version} is merged into ${production}. Review the notes, then publish.`
}

export function publishLabel(version: string): string {
  return `Publish v${version}`
}

export function publishDialogTitle(version: string): string {
  return `Publish v${version}?`
}

export function publishDialogBody(version: string, production: string, oid: string, hook: string | null): string {
  const tagged = `This tags ${oid} on ${production} as v${version} and publishes a GitHub release with these notes.`
  return hook === null ? tagged : `${tagged} Then it runs ${hook}.`
}

export const OPENING_PENDING = 'Opening the release PR…'

export function publishingPending(version: string): string {
  return `Publishing v${version}…`
}

export function publishedToast(version: string): string {
  return `Published v${version}.`
}

export function abandonedCopy(release: PullLink, version: string): string {
  return `PR#${String(release.number)} for v${version} was closed without merging. Reopen it on GitHub to continue.`
}

export function conflictCopy(branches: readonly string[]): string {
  return `${branches.length === 2 ? 'Two' : String(branches.length)} bump branches are open: ${branches.join(', ')}. Delete one on GitHub.`
}

const MUTED_LINES = {
  off: 'Releases are off for this repository.',
  'single-branch': 'This repository has one long-lived branch, so there is nothing to release into.',
  misconfigured: 'release.versionFiles is empty, so there is no version to bump. Fix .claude/port.config.json.',
  'needs-terminal': "This repository bumps its version with release.versionCommand, which port doesn't run. Cut this release with /port:release in a terminal.",
} as const

export function mutedLine(kind: keyof typeof MUTED_LINES): string {
  return MUTED_LINES[kind]
}

/** Names the hook failure and how to recover; a publish never rolls back, so the line starts from "published". */
export function hookFailureCopy(version: string, hook: Exclude<HookOutcome, { kind: 'skipped' } | { kind: 'ok' }>, command: string | null): string {
  const run = command === null ? 'the hook' : command
  if (hook.kind === 'unrunnable') return `v${version} is published. The post-publish hook couldn't run (${hook.message}), so run ${run} yourself.`
  return `v${version} is published. The post-publish hook failed (${hook.exitCode === null ? 'no exit code' : `exit ${String(hook.exitCode)}`}), so run ${run} yourself.`
}

const STEP_LABELS = { bump: 'push the bump commit', 'bump-pr': 'open the bump PR', 'release-pr': 'open the release PR', publish: 'publish the release' } as const

/** The toast for a `refused` or `failed` result; every other result has its own success path. */
export function runProblemCopy(result: Extract<ReleaseRunResult, { kind: 'refused' | 'failed' }>): string {
  if (result.kind === 'refused') return result.message
  const firstLine = result.stderr.trim().split('\n')[0] ?? ''
  return `Couldn't ${STEP_LABELS[result.step]}${firstLine === '' ? '.' : `: ${firstLine}`} What was created stays; run it again to resume.`
}
