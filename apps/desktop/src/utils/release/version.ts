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
