// Every lead-copy string the Needs you screen renders, one switch over
// `NeedsYouItem.kind` — a new kind is a compile error, never a blank row.
import type { NeedsYouItem } from '../../../shared/board/needs-you'

function labelOf(item: Pick<NeedsYouItem, 'number'>): string {
  return item.number !== null ? `#${String(item.number)}` : 'this item'
}

/** The reason text behind `needs-human`, or `null` for the fallback copy. */
function unblockReason(item: NeedsYouItem): string | null {
  const decision = item.matchedRow?.decisions.unblock
  if (decision === undefined || !decision.available) return null
  return 'reason' in decision.context ? decision.context.reason : null
}

export function needsYouLeadCopy(item: NeedsYouItem): string {
  const label = labelOf(item)
  switch (item.kind) {
    case 'plan-review':
      return `Review the plan for ${label}`
    case 'ready-to-merge':
      return `${label} is ready to merge`
    case 'needs-human':
      return `Unblock ${label}: ${unblockReason(item) ?? 'escalated without a reason'}`
    case 'blocked':
      return `Unblock ${label}: an agent marked it blocked`
    case 'budget':
      switch (item.note.kind) {
        case 'escalation-failed':
          return `${label} went over budget, but the escalation write failed (${item.note.outcome.kind})`
        default:
          return `${label} went over budget and needs you`
      }
    case 'held':
      switch (item.held.reason) {
        case 'conflicting':
          return `${label} can't be reviewed: its branch conflicts with the base branch. Refresh it.`
        case 'contended': {
          const paths = item.held.contention?.paths.length ?? 0
          return `${label} waits on #${String(item.held.contention?.blocker ?? 0)}: both change ${String(paths)} file${paths === 1 ? '' : 's'}`
        }
        default: {
          const escalation = item.held.escalation
          const count = escalation?.kind === 'cycle-cap' ? escalation.count : 0
          const cap = escalation?.kind === 'cycle-cap' ? escalation.cap : 0
          return `${label} hit the review cycle cap (${String(count)} of ${String(cap)}). Decide how to continue.`
        }
      }
    case 'stalled':
      return `Retry ${label}: its agent stopped responding`
  }
}
