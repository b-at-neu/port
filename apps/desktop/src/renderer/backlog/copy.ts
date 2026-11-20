// Every string the Backlog screen renders for a failure or an edge case — pure, one function per concern.
import type { BacklogDetailFailureKind } from '@/types/backlog'
import type { PipelineFailureKind } from '@/types/github'

// The plan's own UX-states table, verbatim.
export function backlogFailureCopy(repo: string, kind: PipelineFailureKind, message: string): string {
  switch (kind) {
    case 'unauthenticated':
      return 'gh is signed out. Run `gh auth login`.'
    case 'not-found':
      return "gh isn't installed. Install it, then retry."
    case 'rate-limited':
      return "GitHub's rate limit is used up. Retry in a few minutes."
    case 'network':
    case 'timeout':
      return "Couldn't reach GitHub. Check your connection, then retry."
    case 'repo-not-found':
    case 'http-not-found':
    case 'forbidden':
      return `GitHub can't find ${repo}, or your account can't read it.`
    default:
      return `Couldn't read open tickets: ${message}`
  }
}

export function backlogTruncatedCopy(scanned: number): string {
  return `Showing the ${String(scanned)} newest open tickets. Older ones aren't listed.`
}

export function backlogEmptyGroupCopy(repo: string): string {
  return `Every open ticket in ${repo} is already in a pipeline.`
}

export function backlogCountCopy(repo: string, shown: number, total: number): string {
  return shown === total ? `${repo} · ${String(total)}` : `${repo} · ${String(shown)} of ${String(total)}`
}

export function backlogFilterButtonCopy(active: number): string {
  return active === 0 ? 'Labels' : `Labels · ${String(active)}`
}

export const BACKLOG_FILTER_HINT = 'Click a label to show only it. Click again to hide it.'

export const BACKLOG_FILTER_CLEAR = 'Clear filter'

export function backlogFilterStateCopy(state: 'any' | 'only' | 'hidden'): string {
  return state === 'only' ? 'Only' : state === 'hidden' ? 'Hidden' : ''
}

export function backlogFilterOptionAria(name: string, state: 'any' | 'only' | 'hidden'): string {
  return `${name}, ${state === 'only' ? 'showing only' : state === 'hidden' ? 'hidden' : 'not filtered'}`
}

export function backlogFilteredEmptyCopy(repo: string): string {
  return `No open tickets in ${repo} match the label filter.`
}

export function backlogRepoFilterButtonCopy(shown: number, total: number): string {
  return shown === total ? 'Repositories' : `Repositories · ${String(shown)} of ${String(total)}`
}

export const BACKLOG_REPO_FILTER_SHOW_ALL = 'Show all'

export function backlogGroupToggleAria(repo: string, collapsed: boolean): string {
  return `${collapsed ? 'Expand' : 'Collapse'} ${repo}`
}

export const BACKLOG_ALL_HIDDEN = 'Every repository is hidden by the filter.'

export const BACKLOG_BLOCKED_LABEL = 'Blocked'

export const BACKLOG_START_ANYWAY = 'Start anyway'

export const BACKLOG_BLOCKED_TOOLTIP_HEADING = 'Blocked by:'

export function backlogBlockerLine(blocker: { readonly number: number; readonly title: string }): string {
  return `#${String(blocker.number)} ${blocker.title}`
}

export function backlogBlockerTruncatedCopy(shown: number, total: number): string {
  return `Showing ${String(shown)} of ${String(total)} blockers.`
}

export function backlogStartAnywayTitle(number: number): string {
  return `Start #${String(number)} anyway?`
}

export function backlogBlockedReasonCopy(count: number): string {
  return count === 1 ? "It's blocked by 1 open ticket:" : `It's blocked by ${String(count)} open tickets:`
}

export const BACKLOG_EPIC_TAG = 'Epic'
export const BACKLOG_WAVES_MAY_SHIFT = 'Wave numbers may change. Not every dependency could be read.'

export function backlogWaveLabel(number: number): string {
  return `Wave ${String(number)}`
}

export function backlogWaveBandCopy(number: number, inProgress: number): string {
  return `${backlogWaveLabel(number)} · ${String(inProgress)} in progress`
}

export function backlogEpicProgressCopy(done: number, total: number, inProgress: number): string {
  const base = `${String(done)}/${String(total)}`
  return inProgress > 0 ? `${base} · ${String(inProgress)} in progress` : base
}

export function backlogEpicProgressAria(done: number, total: number, inProgress: number): string {
  const base = `${String(done)} of ${String(total)} sub-issues done`
  return inProgress > 0 ? `${base}, ${String(inProgress)} in progress` : base
}

export function backlogEpicProgressTooltip(done: number, inProgress: number, total: number): string {
  return `${String(done)} done · ${String(inProgress)} in progress · ${String(Math.max(0, total - done - inProgress))} not started`
}

export function backlogEpicTruncatedCopy(shown: number, total: number): string {
  return `Counted ${String(shown)} of ${String(total)} sub-issues.`
}

export function backlogEpicToggleAria(number: number, collapsed: boolean): string {
  return `${collapsed ? 'Expand' : 'Collapse'} #${String(number)}`
}

export function backlogDetailToggleAria(number: number, open: boolean): string {
  return `${open ? 'Hide' : 'Show'} details for #${String(number)}`
}

export function backlogEpicInfoAria(number: number, open: boolean): string {
  return `${open ? 'Hide' : 'Show'} info for #${String(number)}`
}

export function backlogDetailRegionAria(number: number): string {
  return `Details for #${String(number)}`
}

export const BACKLOG_META_BLOCKED_BY = 'Blocked by'

export const BACKLOG_META_BLOCKS = 'Blocks'

export const BACKLOG_META_AUTHOR = 'Author'

export const BACKLOG_META_UPDATED = 'Updated'

export const BACKLOG_META_ASSIGNEE = 'Assignee'

export const BACKLOG_META_DONE = 'Done'

export const BACKLOG_META_IN_PROGRESS = 'In progress'

export const BACKLOG_META_CAN_START = 'Can start now'

export const BACKLOG_META_OPENED = 'Opened'

export const BACKLOG_DETAIL_NONE = 'None'

export const BACKLOG_DETAIL_UNASSIGNED = 'Unassigned'

export const BACKLOG_DETAIL_NO_BODY = 'No description.'

export const BACKLOG_DETAIL_UNREADABLE = "Couldn't read"

export const BACKLOG_DETAIL_RETRY = 'Retry'

export const BACKLOG_EPIC_SUBISSUES_UNREADABLE = "Couldn't read sub-issues"

export function backlogDetailMoreCopy(more: number): string {
  return `+${String(more)} more`
}

export function backlogEpicDoneCopy(done: number, total: number): string {
  return `${String(done)} of ${String(total)} done`
}

export function backlogEpicInProgressCopy(count: number): string {
  return `${String(count)} in progress`
}

export function backlogDetailFailureCopy(number: number, kind: BacklogDetailFailureKind, message: string): string {
  switch (kind) {
    case 'issue-missing':
      return `#${String(number)} is no longer an open ticket. Refresh the backlog.`
    case 'issue-closed':
      return `#${String(number)} was closed. Refresh the backlog.`
    case 'unauthenticated':
    case 'not-found':
    case 'rate-limited':
    case 'network':
    case 'timeout':
      return backlogFailureCopy('', kind, message)
    default:
      return `Couldn't load the details of #${String(number)}: ${message}`
  }
}

export function backlogDetailInvokeErrorCopy(number: number): string {
  return `Couldn't load the details of #${String(number)}. Retry, or refresh the backlog.`
}

export function backlogInvokeErrorCopy(repo: string): string {
  return `Couldn't load open tickets for ${repo}. Retry, or check the repository on Repositories.`
}

export function backlogNotReadyCopy(repo: string): string {
  return `${repo} isn't ready, so its tickets aren't listed. Fix it on Repositories.`
}
