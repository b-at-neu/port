import { describe, expect, it } from 'vitest'
import { cleanTitle, draftNotes, entriesFromCommits, renderReleaseBody } from '@/utils/release/changelog'
import type { ResolvedTicket } from '@/utils/release/changelog'

const TICKETS = new Map<number, ResolvedTicket>([
  [169, { title: '#169 feat(ui)!: Add dark mode', labels: ['enhancement'], bot: false }],
  [153, { title: 'Bump vite to 7.1', labels: [], bot: true }],
  [115, { title: 'Update lockfile', labels: ['dependencies'], bot: false }],
])

describe('cleanTitle', () => {
  it('drops a leading ticket number and a conventional prefix', () => {
    expect(cleanTitle('#169 feat(ui)!: Add dark mode')).toBe('Add dark mode')
    expect(cleanTitle('fix: stop crashing')).toBe('stop crashing')
    expect(cleanTitle('Plain title')).toBe('Plain title')
  })
})

describe('entriesFromCommits', () => {
  it('skips merges, dedupes numbers, keeps numberless subjects and marks dependencies', () => {
    const entries = entriesFromCommits(
      [
        { subject: '#169 add dark mode', parents: 1 },
        { subject: 'Merge pull request #170 from x/y', parents: 2 },
        { subject: 'tidy the repo', parents: 1 },
        { subject: '#169 follow-up for dark mode', parents: 1 },
        { subject: '#153 bump vite', parents: 1 },
        { subject: '#115 refresh lock', parents: 1 },
        { subject: '#999 unknown ticket subject', parents: 1 },
      ],
      TICKETS,
    )
    expect(entries.map((e) => [e.number, e.title, e.dependency])).toEqual([
      [169, 'Add dark mode', false],
      [null, 'tidy the repo', false],
      [153, 'Bump vite to 7.1', true],
      [115, 'Update lockfile', true],
      [999, 'unknown ticket subject', false],
    ])
    expect(entries[0]?.labels).toEqual(['enhancement'])
  })
})

describe('release body and notes', () => {
  const entries = entriesFromCommits(
    [
      { subject: '#169 add dark mode', parents: 1 },
      { subject: 'tidy the repo', parents: 1 },
      { subject: '#153 bump vite', parents: 1 },
    ],
    TICKETS,
  )

  it('renders Changes, and Dependencies only when there are some', () => {
    expect(renderReleaseBody('0.3.0', entries)).toBe('## Release v0.3.0\n\n### Changes\n- #169 Add dark mode\n- tidy the repo\n\n### Dependencies\n- #153 Bump vite to 7.1\n')
    expect(renderReleaseBody('0.3.0', entries.slice(0, 2))).not.toContain('### Dependencies')
  })

  it('drafts one plain bullet per non-dependency entry and always ends with the fixed bullet', () => {
    expect(draftNotes(entries)).toBe('- Add dark mode\n- tidy the repo\n- Minor enhancements and bug fixes\n')
    expect(draftNotes([])).toBe('- Minor enhancements and bug fixes\n')
  })
})
