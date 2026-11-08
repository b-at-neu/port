import { describe, expect, it } from 'vitest'
import type { ReleaseEntry } from '@/types/release'
import { cleanTitle, draftNotes, renderReleaseBody } from '@/utils/release/changelog'

function pr(number: number, title: string, dependency: boolean): ReleaseEntry {
  return { number, title, url: `https://github.com/acme/widgets/pull/${String(number)}`, labels: [], mergedAt: '2026-08-02T00:00:00Z', dependency }
}

describe('cleanTitle', () => {
  it('drops a leading ticket number and a conventional prefix', () => {
    expect(cleanTitle('#169 feat(ui)!: Add dark mode')).toBe('Add dark mode')
    expect(cleanTitle('fix: stop crashing')).toBe('stop crashing')
    expect(cleanTitle('Plain title')).toBe('Plain title')
  })
})

describe('release body and notes', () => {
  const entries = [pr(169, 'Add dark mode', false), pr(170, 'Tidy the repo', false), pr(153, 'Bump vite to 7.1', true)]

  it('renders Changes, and Dependencies only when there are some', () => {
    expect(renderReleaseBody('0.3.0', entries)).toBe('## Release v0.3.0\n\n### Changes\n- #169 Add dark mode\n- #170 Tidy the repo\n\n### Dependencies\n- #153 Bump vite to 7.1\n')
    expect(renderReleaseBody('0.3.0', entries.slice(0, 2))).not.toContain('### Dependencies')
  })

  it('drafts one plain bullet per non-dependency entry and always ends with the fixed bullet', () => {
    expect(draftNotes(entries)).toBe('- Add dark mode\n- Tidy the repo\n- Minor enhancements and bug fixes\n')
    expect(draftNotes([])).toBe('- Minor enhancements and bug fixes\n')
  })
})
