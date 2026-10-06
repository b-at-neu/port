// Every lead-copy string the Needs you screen renders, one switch over
// `NeedsYouItem.kind` (the same rule `board/tick.ts`/`board/copy.ts` already
// state) — a new kind is a compile error here, never a silently blank row.
// DESIGN §6: a message that needs the operator leads with the action.
import type { NeedsYouItem } from '../../../shared/board/needs-you'
import type { RelayPending } from '../../../shared/relay/types'

function labelOf(item: Pick<NeedsYouItem, 'number'>): string {
  return item.number !== null ? `#${String(item.number)}` : 'this item'
}

function questionLeadCopy(pending: RelayPending, label: string): string {
  switch (pending.kind) {
    case 'questions': {
      const [first, ...rest] = pending.questions
      const more = rest.length > 0 ? ` (+${String(rest.length)} more)` : ''
      return `${label} is asking: ${first?.text ?? ''}${more}`
    }
    case 'blocked':
      return `${label} needs a decision: ${pending.request}`
    case 'usage-limit':
      return `${label} hit the session limit. Nothing moves until the window resets.`
  }
}

/** The reason text behind `needs-human` — `decisions.unblock`'s own context
 *  when available, `null` otherwise (an already-unblockable item, or one at
 *  the cycle cap, still gets the fallback "escalated without a reason"). */
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
    case 'question':
      return questionLeadCopy(item.pending, label)
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
