// Semver parsing and the three release candidates — a malformed version is `null`, never a guess.
import type { ReleaseEntry, VersionCandidate, VersionKind } from '@/types/release'

export interface ParsedVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: string | null
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/
const ENHANCEMENT_LABEL = /enhancement|feature/i

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

function listOf(numbers: readonly number[]): string {
  const tags = numbers.map((n) => `#${String(n)}`)
  if (tags.length <= 2) return tags.join(' and ')
  return `${tags.slice(0, -1).join(', ')} and ${tags[tags.length - 1] ?? ''}`
}

function enhancementNumbers(entries: readonly ReleaseEntry[]): readonly number[] {
  const numbers: number[] = []
  for (const entry of entries) {
    if (entry.number !== null && entry.labels.some((label) => ENHANCEMENT_LABEL.test(label))) numbers.push(entry.number)
  }
  return numbers
}

function reasonFor(kind: VersionKind, enhancements: readonly number[], total: number): string {
  if (kind === 'major') return 'No breaking-change signal found. Pick this only on purpose.'
  if (kind === 'minor') {
    if (enhancements.length === 0) return 'No ticket is labelled an enhancement. Pick this when the changes add something users can see.'
    const rest = total - enhancements.length
    return `${listOf(enhancements)} ${enhancements.length === 1 ? 'is an enhancement' : 'are enhancements'}; the other ${String(rest)} ${rest === 1 ? 'is a fix or chore' : 'are fixes and chores'}`
  }
  if (enhancements.length === 0) return `All ${String(total)} changes are fixes and chores`
  return `Enhancements are in this release, so minor is the recommendation. Pick this only to ship fixes alone.`
}

/** Minor when any ticket is an enhancement, otherwise patch; major is offered and never recommended. */
export function buildCandidates(current: string, entries: readonly ReleaseEntry[]): readonly VersionCandidate[] {
  const parsed = parseVersion(current)
  if (parsed === null) return []
  const enhancements = enhancementNumbers(entries)
  const recommended: VersionKind = enhancements.length > 0 ? 'minor' : 'patch'
  const order: readonly VersionKind[] = ['minor', 'patch', 'major']
  const kinds = [recommended, ...order.filter((kind) => kind !== recommended)]
  return kinds.map((kind) => ({
    kind,
    version: bumped(parsed, kind),
    recommended: kind === recommended,
    reason: reasonFor(kind, enhancements, entries.length),
    tickets: kind === 'minor' || kind === recommended ? enhancements : [],
  }))
}
