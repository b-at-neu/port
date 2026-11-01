// Compare commits to changelog entries, the release PR body and the notes draft — the mechanical stand-ins for what the release skill has Claude write.
import type { ReleaseEntry } from '@/types/release'
import { RELEASE_LITERALS } from '@/utils/release/format'

export interface ChangelogCommit {
  readonly subject: string
  readonly parents: number
}

export interface ResolvedTicket {
  readonly title: string
  readonly labels: readonly string[]
  readonly bot: boolean
}

const TICKET_NUMBER = /#(\d+)/g
const LEADING_NUMBER = /^#\d+\s+/
const CONVENTIONAL_PREFIX = /^\w+(\([^)]*\))?!?:\s*/
const DEPENDENCY_LABEL = /dependenc/i

/** The subject of a numberless commit, or a ticket title, without `#<n> ` or a `type(scope)!:` prefix. */
export function cleanTitle(title: string): string {
  const cleaned = title.trim().replace(LEADING_NUMBER, '').replace(CONVENTIONAL_PREFIX, '').trim()
  return cleaned === '' ? title.trim() : cleaned
}

export function ticketNumbersOf(subject: string): readonly number[] {
  return [...subject.matchAll(TICKET_NUMBER)].map((match) => Number(match[1]))
}

/** `commits` is newest first. A commit with more than one parent is a merge and is skipped, as the skill's `--no-merges` does. */
export function entriesFromCommits(commits: readonly ChangelogCommit[], tickets: ReadonlyMap<number, ResolvedTicket>): readonly ReleaseEntry[] {
  const entries: ReleaseEntry[] = []
  const seen = new Set<number>()
  for (const commit of commits) {
    if (commit.parents > 1) continue
    const numbers = ticketNumbersOf(commit.subject)
    if (numbers.length === 0) {
      entries.push({ number: null, title: cleanTitle(commit.subject), labels: [], dependency: false })
      continue
    }
    for (const number of numbers) {
      if (seen.has(number)) continue
      seen.add(number)
      const ticket = tickets.get(number)
      entries.push({
        number,
        title: cleanTitle(ticket?.title ?? commit.subject),
        labels: ticket?.labels ?? [],
        dependency: ticket !== undefined && (ticket.bot || ticket.labels.some((label) => DEPENDENCY_LABEL.test(label))),
      })
    }
  }
  return entries
}

function bullet(entry: ReleaseEntry): string {
  return entry.number === null ? `- ${entry.title}` : `- #${String(entry.number)} ${entry.title}`
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
