// Which reasons make Work on ask first — pure, so the dialog and the row tag read one rule.
import type { BacklogRowView, WorkOnReasons } from '@/types/backlog'
import type { ClaimBlocker } from '@/types/github'

// An unreadable blocker read counts as not blocked: the claim preflight re-reads and reports it.
export function openBlockersOf(row: Pick<BacklogRowView, 'blockers'>): readonly ClaimBlocker[] {
  return row.blockers.ok ? row.blockers.open : []
}

export function truncationOf(row: Pick<BacklogRowView, 'blockers'>): WorkOnReasons['truncation'] {
  const { blockers } = row
  return blockers.ok && blockers.total > blockers.shown ? { shown: blockers.shown, total: blockers.total } : null
}

export function workOnReasons(row: BacklogRowView): WorkOnReasons | null {
  const blockers = openBlockersOf(row)
  if (blockers.length === 0 && row.subIssueCount === 0) return null
  return { blockers, truncation: truncationOf(row), subIssueCount: row.subIssueCount }
}
