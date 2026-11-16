// Semver parsing and the three bump options — a malformed version is `null`, never a guess.
import type { VersionKind, VersionOption } from '@/types/release'

export interface ParsedVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: string | null
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/

/** Strips one leading `v` and surrounding whitespace, then requires `X.Y.Z[-pre]`. */
export function parseVersion(text: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(text.trim().replace(/^v/, ''))
  if (match === null) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ?? null }
}

/** The canonical `X.Y.Z[-pre]` spelling, or `null` when the text does not parse. */
export function normalizeVersion(text: string): string | null {
  const parsed = parseVersion(text)
  if (parsed === null) return null
  const core = `${String(parsed.major)}.${String(parsed.minor)}.${String(parsed.patch)}`
  return parsed.prerelease === null ? core : `${core}-${parsed.prerelease}`
}

/** An open dev window's `1.5.0-dev` marks work toward `1.5.0`, never a version in flight. */
export function stripPrerelease(text: string): string | null {
  const parsed = parseVersion(text)
  return parsed === null ? null : `${String(parsed.major)}.${String(parsed.minor)}.${String(parsed.patch)}`
}

/** True when the first prerelease identifier is exactly `dev` (`1.4.2-dev`, `1.5.0-dev.3`); unparseable text is not dev. */
export function isDevVersion(text: string): boolean {
  const parsed = parseVersion(text)
  return parsed?.prerelease?.split('.')[0] === 'dev'
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a)
  const bNumeric = /^\d+$/.test(b)
  if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b))
  if (aNumeric) return -1
  if (bNumeric) return 1
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** SemVer 2.0 precedence: negative when `a` ranks below `b`, positive above, zero when equal. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  const core = Math.sign(a.major - b.major) || Math.sign(a.minor - b.minor) || Math.sign(a.patch - b.patch)
  if (core !== 0) return core
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === null) return 1
  if (b.prerelease === null) return -1
  const left = a.prerelease.split('.')
  const right = b.prerelease.split('.')
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const order = compareIdentifiers(left[index] ?? '', right[index] ?? '')
    if (order !== 0) return order
  }
  return Math.sign(left.length - right.length)
}

function bumped(current: ParsedVersion, kind: VersionKind): string {
  if (kind === 'major') return `${String(current.major + 1)}.0.0`
  if (kind === 'minor') return `${String(current.major)}.${String(current.minor + 1)}.0`
  return `${String(current.major)}.${String(current.minor)}.${String(current.patch + 1)}`
}

const BUMP_KINDS: readonly VersionKind[] = ['patch', 'minor', 'major']

/** Patch, minor and major from `current`, none preferred; `[]` when `current` does not parse. */
export function bumpOptions(current: string): readonly VersionOption[] {
  const parsed = parseVersion(current)
  if (parsed === null) return []
  return BUMP_KINDS.map((kind) => ({ kind, version: bumped(parsed, kind) }))
}
