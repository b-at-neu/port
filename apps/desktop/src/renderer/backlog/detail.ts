import type { BacklogAssigneeView, BacklogEpicSummary, BacklogEpicSummaryView, BacklogLinkList, BacklogLinkListView } from '@/types/backlog'

export function detailPanelId(key: string): string {
  return `backlog-detail-${key.replace(/[^A-Za-z0-9_-]/g, '-')}`
}

export function linkListView(list: BacklogLinkList): BacklogLinkListView {
  if (!list.ok) return { kind: 'failed', reason: list.reason }
  if (list.items.length === 0) return { kind: 'none' }
  const items = list.items.map((link) => ({ number: link.number, title: link.title, url: link.url, closed: link.state === 'CLOSED' }))
  return { kind: 'links', items, more: Math.max(0, list.total - list.items.length) }
}

export function assigneeView(assignees: readonly string[]): BacklogAssigneeView {
  return assignees.length === 0 ? { kind: 'unassigned' } : { kind: 'people', text: assignees.join(', ') }
}

export function epicSummaryView(summary: BacklogEpicSummary, epicUrl: string): BacklogEpicSummaryView {
  if (!summary.ok) return { ok: false, reason: summary.reason }
  return {
    ok: true,
    done: summary.done,
    total: summary.total,
    inProgress: summary.inProgress,
    canStart: summary.canStart.map((child) => ({ number: child.number, title: child.title, url: epicUrl.replace(/\/\d+$/, `/${String(child.number)}`) })),
    truncated: summary.truncated,
  }
}
