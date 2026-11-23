import type { BacklogAssigneeView, BacklogEpicGroup, BacklogEpicSummary, BacklogEpicSummaryView, BacklogGroupView, BacklogLinkList, BacklogLinkListView } from '@/types/backlog'
import type { RepoId } from '@/utils/repos'

export type BacklogRowPress = 'select' | 'open' | 'close'

/** A control or non-primary press only selects; a primary press on the shown row closes it, any other opens. */
export function backlogRowPress({ key, detailKey, button, onControl }: { readonly key: string; readonly detailKey: string | null; readonly button: number; readonly onControl: boolean }): BacklogRowPress {
  if (onControl || button !== 0) return 'select'
  return key === detailKey ? 'close' : 'open'
}

function searchEpics(epics: readonly BacklogEpicGroup[], number: number): BacklogEpicGroup | null {
  for (const epic of epics) {
    if (epic.epic.number === number) return epic
    const nested = searchEpics(epic.epics, number)
    if (nested) return nested
  }
  return null
}

export function findEpicGroup(groups: readonly BacklogGroupView[], repoId: RepoId, number: number): BacklogEpicGroup | null {
  for (const group of groups) {
    if (group.kind !== 'loaded' || group.repoId !== repoId) continue
    const found = searchEpics(group.layout.entries.flatMap((entry) => (entry.kind === 'epic' ? [entry.group] : [])), number)
    if (found) return found
  }
  return null
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
