// A pull request title without its ticket prefix, the release PR body and the notes draft — the mechanical stand-ins for what the release skill has Claude write.
import type { ReleaseEntry } from '@/types/release'
import { RELEASE_LITERALS } from '@/utils/release/format'

const LEADING_NUMBER = /^#\d+\s+/
const CONVENTIONAL_PREFIX = /^\w+(\([^)]*\))?!?:\s*/

/** A pull request title without `#<n> ` or a `type(scope)!:` prefix. */
export function cleanTitle(title: string): string {
  const cleaned = title.trim().replace(LEADING_NUMBER, '').replace(CONVENTIONAL_PREFIX, '').trim()
  return cleaned === '' ? title.trim() : cleaned
}

function bullet(entry: ReleaseEntry): string {
  return `- #${String(entry.number)} ${entry.title}`
}

/** `## Release v<version>`, `### Changes`, and `### Dependencies` only when there is one. */
export function renderReleaseBody(version: string, entries: readonly ReleaseEntry[]): string {
  const changes = entries.filter((entry) => !entry.dependency).map(bullet)
  const dependencies = entries.filter((entry) => entry.dependency).map(bullet)
  const lines = [`## Release v${version}`, '', '### Changes', ...changes]
  if (dependencies.length > 0) lines.push('', '### Dependencies', ...dependencies)
  return `${lines.join('\n')}\n`
}

/** One plain bullet per non-dependency entry, no ticket numbers, always ending in the fixed bullet. */
export function draftNotes(entries: readonly ReleaseEntry[]): string {
  const bullets = entries.filter((entry) => !entry.dependency).map((entry) => `- ${entry.title}`)
  return `${[...bullets, RELEASE_LITERALS.notesFooter].join('\n')}\n`
}
