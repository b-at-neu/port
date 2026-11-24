import { describe, expect, it } from 'vitest'
import type { BacklogRowView } from '@/types/backlog'
import { workOnReasons } from '@/renderer/backlog/confirm'
import { backlogRow } from '../../../support/backlog-row'

const BLOCKER = { number: 43, title: 'Rate-limit search', url: 'u43', state: 'OPEN' }
const blockers = (open: readonly (typeof BLOCKER)[], shown = open.length, total = open.length): BacklogRowView['blockers'] => ({ ok: true, open, shown, total })

describe('workOnReasons', () => {
  it.each([
    ['an unblocked row', backlogRow(45), null],
    ['sub-issues and no blockers', backlogRow(45, { subIssueCount: 3 }), null],
    ['an unreadable blocker read, since blocked is advisory', backlogRow(45, { blockers: { ok: false, reason: 'malformed' } }), null],
    ['only closed blockers fetched', backlogRow(45, { blockers: blockers([], 2, 2) }), null],
    ['an open blocker', backlogRow(45, { blockers: blockers([BLOCKER]) }), { blockers: [BLOCKER], truncation: null }],
    ['more blockers than were fetched', backlogRow(45, { blockers: blockers([BLOCKER], 10, 14) }), { blockers: [BLOCKER], truncation: { shown: 10, total: 14 } }],
  ])('is decided by %s', (_name, row, expected) => {
    expect(workOnReasons(row)).toEqual(expected)
  })
})
