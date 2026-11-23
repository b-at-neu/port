import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { BacklogRowView } from '@/types/backlog'
import type { BlockerRead } from '@/types/github'
import { workOnReasons } from '@/renderer/backlog/confirm'

const BLOCKER = { number: 43, title: 'Rate-limit search', url: 'https://github.com/acme/widgets/issues/43', state: 'OPEN' }

function row(overrides: Partial<BacklogRowView> = {}): BacklogRowView {
  return {
    repoId: 'repo-a' as RepoId,
    repo: 'acme/widgets',
    number: 45,
    title: 'Document retries',
    url: 'u',
    assignee: null,
    createdAt: 'x',
    labels: [],
    subIssueCount: 0,
    blockers: { ok: true, open: [], shown: 0, total: 0 },
    blocking: { ok: true, open: [], shown: 0, total: 0 },
    parent: { ok: true, parent: null },
    children: { ok: true, children: [], shown: 0, total: 0 },
    ...overrides,
  }
}

function blockedBy(open: readonly (typeof BLOCKER)[], shown = open.length, total = open.length): BlockerRead {
  return { ok: true, open, shown, total }
}

describe('workOnReasons', () => {
  it('is null for an unblocked row', () => {
    expect(workOnReasons(row())).toBeNull()
  })

  it('lists the open blockers for a blocked row', () => {
    expect(workOnReasons(row({ blockers: blockedBy([BLOCKER]) }))).toEqual({ blockers: [BLOCKER], truncation: null })
  })

  it('is null for a row with sub-issues and no blockers', () => {
    expect(workOnReasons(row({ subIssueCount: 3 }))).toBeNull()
  })

  it('is null for an unreadable blocker read, since blocked is advisory', () => {
    expect(workOnReasons(row({ blockers: { ok: false, reason: 'blockedBy is malformed' } }))).toBeNull()
  })

  it('is null when every blocker is closed, even if some were fetched', () => {
    expect(workOnReasons(row({ blockers: blockedBy([], 2, 2) }))).toBeNull()
  })

  it('flags truncation when the connection holds more blockers than were fetched', () => {
    expect(workOnReasons(row({ blockers: blockedBy([BLOCKER], 10, 14) }))?.truncation).toEqual({ shown: 10, total: 14 })
  })
})
