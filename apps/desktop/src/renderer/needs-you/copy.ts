// Every lead-copy string the Needs you screen renders, one switch over
// `NeedsYouItem.kind` — a new kind is a compile error, never a blank row.
import type { NeedsYouGroupKey, NeedsYouItem } from '@/types/board'
import type { InterruptedStage } from '@/types/stage'
import type { StageAgent } from '@/types/tick'

const STAGE_PHASE_NAME: Readonly<Record<StageAgent, string>> = { plan: 'Planning', impl: 'Implementing', review: 'Reviewing', revise: 'Revising' }

export const GROUP_NAMES: Readonly<Record<NeedsYouGroupKey, string>> = {
  'plan-review': 'Plan reviews',
  'ready-to-merge': 'Ready to merge',
  'needs-human': 'Escalated',
  blocked: 'Blocked',
  questions: 'Questions',
  denied: 'Denied commands',
  interrupted: 'Interrupted',
  'usage-limit': 'Usage limit',
  held: 'Held',
  stalled: 'Stalled',
  budget: 'Over budget',
  'half-labelled': 'Label problems',
}

function clockTime(at: string): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`
}

/** `Usage limit — resets 14:05 · 3 sessions waiting`; once the reset has passed it reads `reset at`, and without a known reset it says so. */
function usageLimitCopy(item: Extract<NeedsYouItem, { readonly kind: 'usage-limit' }>, now: Date): string {
  const waiting = `${plural(item.entries.length, 'session')} waiting`
  if (item.resetsAt === null) return `Usage limit — reset time unknown · ${waiting}`
  if (Date.parse(item.resetsAt) <= now.getTime()) return `Usage limit reset at ${clockTime(item.resetsAt)} · ${waiting}`
  return `Usage limit — resets ${clockTime(item.resetsAt)} · ${waiting}`
}

/** One expanded line per waiting session: its number, phase and repository. */
export function usageLimitEntryLine(item: Extract<NeedsYouItem, { readonly kind: 'usage-limit' }>, entry: InterruptedStage): string {
  const repo = item.repoNames.get(entry.repoId)
  return `#${String(entry.number)} ${STAGE_PHASE_NAME[entry.agent]}${repo !== undefined ? ` · ${repo}` : ''}`
}

export const UNDO_LABEL = 'Undo'

export function resumeAllDisabledReason(resetsAt: string): string {
  return `The limit resets at ${clockTime(resetsAt)}. port resumes these sessions then.`
}

export function dismissedToast(items: readonly Pick<NeedsYouItem, 'number'>[]): string {
  const only = items.length === 1 ? items[0] : undefined
  if (only !== undefined) return only.number !== null ? `Dismissed #${String(only.number)}.` : 'Dismissed this item.'
  return `Dismissed ${plural(items.length, 'item')}.`
}

export function resumeAllToast(resumed: number, total: number, slotLimit: number | null, failure: { readonly number: number; readonly reason: string } | null): string {
  if (failure !== null) return `Couldn't resume #${String(failure.number)}: ${failure.reason}.`
  if (resumed === total) return `Resumed ${plural(total, 'session')}.`
  return `Resumed ${String(resumed)} of ${String(total)}. All ${String(slotLimit ?? 0)} session slots are busy.`
}

function labelOf(item: Pick<NeedsYouItem, 'number' | 'ticket'>): string {
  if (item.ticket !== null) return `${item.ticket.kind === 'issue' ? '#' : 'PR#'}${String(item.ticket.number)}`
  return item.number !== null ? `#${String(item.number)}` : 'this item'
}

/** The reason text behind `needs-human`, or `null` for the fallback copy. */
function unblockReason(item: NeedsYouItem): string | null {
  const decision = item.matchedRow?.decisions.unblock
  if (decision === undefined || !decision.available) return null
  return 'reason' in decision.context ? decision.context.reason : null
}

/** The repository's own resolved label name for a repair's label key — the matched row's `item.stages`
 *  already carries every label's resolved name, so this never re-derives one from the bare key. */
function repairLabelName(item: Extract<NeedsYouItem, { readonly kind: 'half-labelled' }>, key: string): string {
  return item.matchedRow?.item.stages.find((s) => s.key === key)?.name ?? key
}

function interruptedCopy(item: Extract<NeedsYouItem, { readonly kind: 'stage-interrupted' }>, label: string): string {
  const i = item.interrupted
  const phase = STAGE_PHASE_NAME[i.agent]
  switch (i.reason) {
    case 'quit':
      return `${phase} ${label} was interrupted when port quit`
    case 'crash':
      return `${phase} ${label} stopped unexpectedly`
    case 'usage-limit':
      return `${phase} ${label} hit the usage limit${i.resetsAt !== null ? `, resets ${new Date(i.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`
    case 'error':
      return `${phase} ${label} ended with an error${i.detail !== null ? ` (${i.detail})` : ''}`
  }
}

function halfLabelledCopy(item: Extract<NeedsYouItem, { readonly kind: 'half-labelled' }>, label: string): string {
  const names = item.repair.labels.map((key) => repairLabelName(item, key))
  switch (item.repair.shape) {
    case 'handback-unlabelled': {
      const agentName = item.repair.agent !== null ? STAGE_PHASE_NAME[item.repair.agent].toLowerCase() : 'stage'
      return `${label}'s ${agentName} session finished, but its label is still "${names[0] ?? 'in flight'}". Check the ticket and set the right label.`
    }
    case 'contradictory':
      return `${label} has conflicting labels: ${names.map((n) => `"${n}"`).join(', ')}. Remove the one that's wrong.`
    case 'plan-missing-approved':
      return `${label} is approved, but its body has no implementation plan. Restore the plan or move it back to "ready".`
    case 'pr-missing':
      return `${label} says a pull request is open, but none is. Reopen it or move the issue back.`
  }
}

export function needsYouLeadCopy(item: NeedsYouItem, now: Date = new Date()): string {
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
    case 'stage-question':
      return `${label} is asking: ${item.questions[0]?.header ?? 'a question'}`
    case 'stage-questions':
      return `${label} has questions for you — open its session to answer`
    case 'stage-blocked':
      return `${label} is blocked: ${item.text ?? 'see its session'}`
    case 'stage-denial':
      return `${STAGE_PHASE_NAME[item.denial.agent]} ${label} was denied ${item.denial.rule}`
    case 'stage-interrupted':
      return interruptedCopy(item, label)
    case 'usage-limit':
      return usageLimitCopy(item, now)
    case 'half-labelled':
      return halfLabelledCopy(item, label)
  }
}

export function refreshedToast(count: number): string {
  return count === 0 ? 'Refreshed. Nothing needs you.' : `Refreshed. ${String(count)} item${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} you.`
}

export const REFRESH_FAILED_TOAST = "Couldn't reach the main process. Nothing was refreshed."

export function blockerSentToast(number: number | null): string {
  return `Sent your answer to ${number !== null ? `#${String(number)}'s` : 'the'} agent. It clears "Blocked" itself and carries on.`
}

export function blockerSendError(error: 'unknown-session' | 'blocked-command' | 'unreachable', number: number | null): string {
  if (error === 'unreachable') return "Couldn't reach the main process. Nothing was sent."
  if (error === 'blocked-command') return "That text is a command the session can't run here. Reword your answer."
  return `That session has ended. Unblock ${number !== null ? `#${String(number)}` : 'the item'} from its row once the board catches up.`
}
