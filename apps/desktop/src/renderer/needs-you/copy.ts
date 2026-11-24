// Every lead-copy string the Needs you screen renders, one switch over
// `NeedsYouItem.kind` — a new kind is a compile error, never a blank row.
import type { NeedsYouGroupKey, NeedsYouItem } from '@/types/board'
import { mirrorReason } from '@/renderer/lib/mirror-reason'
import { formatAgo, formatShortClock } from '@/renderer/lib/time'
import type { DecisionRefusal } from '@/types/actions'
import type { InterruptedStage } from '@/types/stage'
import type { HandoffRefusal } from '@/types/tick'
import { agentStageName } from '@/utils/pipeline/stages'

export const GROUP_NAMES: Readonly<Record<NeedsYouGroupKey, string>> = {
  'plan-review': 'Plan reviews',
  'ready-to-merge': 'Ready to merge',
  'needs-human': 'Escalated',
  blocked: 'Blocked',
  questions: 'Questions',
  approvals: 'Edit approvals',
  denied: 'Denied commands',
  interrupted: 'Interrupted',
  'usage-limit': 'Usage limit',
  held: 'Held',
  stalled: 'Stalled',
  budget: 'Over budget',
  'half-labelled': 'Label problems',
  'launch-failed': 'Launch failures',
}

export function nothingInRepoCopy(repo: string): string {
  return `Nothing in ${repo} needs you right now.`
}

export const LAUNCH_FAILED_HELP = 'port retries every few minutes. Fix the cause above and the next attempt picks it up.'

export const LAUNCH_FAILED_NO_DETAIL = 'No error message was recorded.'

export function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`
}

/** `Usage limit — resets 14:05 · 3 sessions waiting`; once the reset has passed it reads `reset at`, and without a known reset it says so. */
function usageLimitCopy(item: Extract<NeedsYouItem, { readonly kind: 'usage-limit' }>, now: Date): string {
  const waiting = `${plural(item.entries.length, 'session')} waiting`
  if (item.resetsAt === null) return `Usage limit — reset time unknown · ${waiting}`
  if (Date.parse(item.resetsAt) <= now.getTime()) return `Usage limit reset at ${formatShortClock(item.resetsAt)} · ${waiting}`
  return `Usage limit — resets ${formatShortClock(item.resetsAt)} · ${waiting}`
}

/** One expanded line per waiting session: its number, phase and repository. */
export function usageLimitEntryLine(item: Extract<NeedsYouItem, { readonly kind: 'usage-limit' }>, entry: InterruptedStage): string {
  const repo = item.repoNames.get(entry.repoId)
  return `#${String(entry.number)} ${agentStageName(entry.agent)}${repo !== undefined ? ` · ${repo}` : ''}`
}

export function resumeAllDisabledReason(resetsAt: string): string {
  return `The limit resets at ${formatShortClock(resetsAt)}. port resumes these sessions then.`
}

export function dismissedToast(items: readonly Pick<NeedsYouItem, 'number'>[]): string {
  const only = items.length === 1 ? items[0] : undefined
  if (only !== undefined) return only.number !== null ? `Dismissed #${String(only.number)}.` : 'Dismissed this item.'
  return `Dismissed ${plural(items.length, 'item')}.`
}

export const DISMISSED_LABEL = 'Dismissed'

export const RESTORE_LABEL = 'Restore'

export const RESTORE_ALL_LABEL = 'Restore all'

export function showDismissedLabel(count: number, open: boolean): string {
  return open ? 'Hide dismissed' : `Show dismissed · ${String(count)}`
}

export function showDismissedAction(count: number): string {
  return `Show ${String(count)} dismissed`
}

export function restoredToast(items: readonly Pick<NeedsYouItem, 'number'>[]): string {
  const only = items.length === 1 ? items[0] : undefined
  if (only !== undefined) return only.number !== null ? `Restored #${String(only.number)}.` : 'Restored this item.'
  return `Restored ${plural(items.length, 'item')}.`
}

export function resumeAllToast(resumed: number, total: number, slotLimit: number | null, failure: { readonly number: number; readonly reason: string } | null): string {
  if (failure !== null) return `Couldn't resume #${String(failure.number)}: ${failure.reason}.`
  if (resumed === total) return `Resumed ${plural(total, 'session')}.`
  return `Resumed ${String(resumed)} of ${String(total)}. All ${String(slotLimit ?? 0)} session slots are busy.`
}

export function labelOf(item: Pick<NeedsYouItem, 'number' | 'ticket'>): string {
  if (item.ticket !== null) return `${item.ticket.kind === 'issue' ? '#' : 'PR#'}${String(item.ticket.number)}`
  return item.number !== null ? `#${String(item.number)}` : 'this item'
}

/** The reason text behind `needs-human`, or `null` for the fallback copy. */
function unblockReason(item: NeedsYouItem): string | null {
  const decision = item.matchedRow?.decisions.unblock
  if (decision === undefined || !decision.available) return null
  return 'reason' in decision.context ? decision.context.reason : null
}

/** The decision behind a `blocked` row: the live session's reason, then the blocker comment's, else `null` for the fallback copy. */
function blockedReason(item: Extract<NeedsYouItem, { readonly kind: 'blocked' }>): string | null {
  const blockedOn = item.row.blockedOn
  return blockedOn?.session?.text ?? blockedOn?.comment?.text ?? null
}

function interruptedCopy(item: Extract<NeedsYouItem, { readonly kind: 'stage-interrupted' }>, label: string): string {
  const i = item.interrupted
  const phase = agentStageName(i.agent)
  switch (i.reason) {
    case 'quit':
      return `${phase} ${label} was interrupted when port quit`
    case 'crash':
      return `${phase} ${label} stopped unexpectedly`
    case 'usage-limit':
      return `${phase} ${label} hit the usage limit${i.resetsAt !== null ? `, resets ${formatShortClock(i.resetsAt)}` : ''}`
    case 'error':
      return `${phase} ${label} ended with an error${i.detail !== null ? ` (${i.detail})` : ''}`
    case 'cleanup-failed':
      return `${phase} ${label} finished, but its worktree is still there${i.detail !== null ? ` (${i.detail})` : ''}`
    case 'network':
      return `${phase} ${label} lost its connection${i.resetsAt !== null ? `, retrying at ${formatShortClock(i.resetsAt)}` : ''}`
  }
}

export const CLEANUP_FAILED_HELP = 'port retries the removal every few minutes. If it has uncommitted changes, commit or discard them there first. This row clears once the worktree is gone.'

export function copiedPathToast(label: string): string {
  return `Copied the worktree path for ${label}.`
}

export function copyPathFailedToast(path: string): string {
  return `Couldn't copy the path. It's ${path}.`
}

const HANDOFF_REFUSAL_COPY: Readonly<Record<HandoffRefusal, string>> = {
  'no-handback': 'it ended without a hand-back line',
  'unknown-handback': "its hand-back line isn't one port knows",
  'pr-unverified': "the pull request it named isn't open on its branch",
  moved: 'its stage changed while it ran',
  'write-failed': 'GitHub kept refusing the change',
  'unresolvable-label': "a label it needs isn't in this repository",
  'no-plan-file': 'it left no plan file to post',
  'empty-plan-file': 'its plan file was empty',
}

function halfLabelledCopy(item: Extract<NeedsYouItem, { readonly kind: 'half-labelled' }>, label: string): string {
  switch (item.repair.shape) {
    case 'handback-unlabelled': {
      const agent = item.repair.agent
      const agentName = agent !== null ? agentStageName(agent).toLowerCase() : 'stage'
      const phase = agent !== null ? agentStageName(agent) : 'its current stage'
      const reason = item.repair.reason === null ? '' : `: ${HANDOFF_REFUSAL_COPY[item.repair.reason]}`
      return `${label}'s ${agentName} session finished, but port couldn't record its next stage${reason}. It stays at ${phase} until port retries it.`
    }
    case 'mirror-failed':
      return `${label}'s GitHub labels are out of date: ${item.repair.mirror === null ? 'a label write failed' : mirrorReason(item.repair.mirror.outcome)}. port tries again on its next poll.`
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
      return `Unblock ${label}: ${blockedReason(item) ?? 'its reason is on the ticket'}`
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
          const cap = escalation?.kind === 'cycle-cap' ? escalation.cap : 0
          return `${label} used all ${String(cap)} review cycles. Grant one more, or merge it and open a follow-up.`
        }
      }
    case 'stalled':
      return `Retry ${label}: its agent stopped responding`
    case 'stage-question':
      return `${label} is asking: ${item.questions[0]?.header ?? 'a question'}`
    case 'stage-approval':
      return `${agentStageName(item.agent)} ${label} wants to edit ${item.path}`
    case 'stage-questions':
      return `${label} has questions for you — open its session to answer`
    case 'stage-denial':
      return `${agentStageName(item.denial.agent)} ${label} was denied ${item.denial.rule}`
    case 'stage-interrupted':
      return interruptedCopy(item, label)
    case 'usage-limit':
      return usageLimitCopy(item, now)
    case 'half-labelled':
      return halfLabelledCopy(item, label)
    case 'dispatch-failed':
      return `${agentStageName(item.record.agent)} ${label} couldn't start${item.attempts > 1 ? ` · ${String(item.attempts)} attempts` : ''}`
  }
}

export function refreshedToast(count: number): string {
  return count === 0 ? 'Refreshed. Nothing needs you.' : `Refreshed. ${String(count)} item${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} you.`
}

export const PROTECTED_EDIT_DENY_MESSAGE = 'The operator denied this protected edit. Carry on without it, or end with BLOCKED: naming the file.'

export const APPROVAL_GONE_TOAST = 'That edit is no longer waiting — the session moved on.'

export function approvedEditToast(path: string): string {
  return `Approved the edit to ${path}.`
}

export function deniedEditToast(path: string): string {
  return `Denied the edit to ${path}.`
}

export const ENDED_DENIAL_LINE = 'The session has ended. Allowing it applies to future runs.'

export const NEEDS_YOU_TITLE = 'Needs you'

export const REFRESH_LABEL = 'Refresh'

export const DISMISS_ALL_LABEL = 'Dismiss all'

export const NOTHING_NEEDS_YOU = 'Nothing needs you right now.'

export const NEEDS_YOU_READ_ERROR = "Can't read the pipeline state. Check that gh is signed in."

export const SHARED_FILES_LABEL = 'Shared files:'

export const PROTECTED_PATH_HELP = 'This path is protected by sessionRequiredPaths. Approving lets this one edit through; port asks again for the next one.'

export const OPEN_SESSION_LABEL = 'Open session'

export const EXPAND_DETAILS_LABEL = 'Expand details'

export const COLLAPSE_DETAILS_LABEL = 'Collapse details'

export const WORKING_LABEL = 'Working…'

export const DISMISS_LABEL = 'Dismiss'

export function staleCopy(ms: number): string {
  return `Updated ${formatAgo(ms)}`
}

export const ACTION_LABELS = {
  reviewPlan: 'Review plan',
  openPr: 'Open PR',
  unblock: 'Unblock',
  openTicket: 'Open ticket',
  dispatchAnyway: 'Dispatch anyway',
  retry: 'Retry',
  answer: 'Answer',
  approve: 'Approve edit',
  deny: 'Deny',
  allow: 'Allow from now on',
  copyPath: 'Copy path',
  resume: 'Resume',
  resumeAll: 'Resume all',
  restart: 'Restart',
  openOnGitHub: 'Open on GitHub',
} as const

export const UNREADABLE_STATE_REASON = "Can't read this item's current state."

export const NOT_RUNNING_REPO_REASON = "This app isn't running this repository."

export const NO_SESSION_ID_REASON = "This session ended before Claude started it, so there's nothing to resume."

export const REVISE_CYCLE_CAP_REASON = 'This PR has used all its review cycles. Sending it back would escalate straight to needs human. Merge it and open a follow-up, or raise reviewCycleCap first.'

export const DECISION_REFUSAL_COPY: Readonly<Record<DecisionRefusal, string>> = {
  'viewer-unknown': "Can't tell which account you're signed in as, so ownership can't be checked.",
  'not-owned': 'Someone else owns this item. Take it over in the cockpit before acting on it here.',
  'cycle-cap': 'Already at the review cycle cap — unblocking would only escalate it straight back.',
  'rebase-decisions': "This rebase escalation's decisions couldn't be read. Answer them with unblock #N in the cockpit.",
  'not-applicable': "This action doesn't apply here.",
  'agent-live': "This item's agent is still waiting in its session. Answer it there and it clears the block itself.",
}

export function ticketRef(number: number | null): string {
  return number === null ? 'this ticket' : `#${String(number)}`
}

export function restartPending(number: number | null): string {
  return `Restarting ${ticketRef(number)}…`
}

export const RESTART_CONFIRM_LABEL = 'Restart stage'

export function restartTitle(agent: string, number: number | null): string {
  return number === null ? 'Restart this stage?' : `Restart ${agent} #${String(number)}?`
}

export function restartDescription(number: number | null): string {
  return `Removes its worktree and puts ${ticketRef(number)} back in the queue, so the next run starts the stage from scratch. Anything it hadn't pushed is lost.`
}

export const FORCE_CONFIRM_LABEL = 'Dispatch anyway'

export function forceDispatchTitle(number: number): string {
  return `Dispatch #${String(number)} anyway?`
}

export function forceDispatchLead(number: number, paths: number, blocker: number, blockerStage: string): string {
  return `#${String(number)} shares ${String(paths)} file(s) with #${String(blocker)} (${blockerStage}):`
}

export const FORCE_DISPATCH_WARNING = 'Both will edit these files at once, so whichever merges second will probably need a rebase.'

export function forceDispatchPending(number: number): string {
  return `Dispatching #${String(number)}…`
}

export const ALLOW_TITLE = 'Allow this from now on?'

export const ALLOW_EXPLANATION = 'Opens a PR into the integration branch that adds this rule to .claude/settings.json and extraAllow in .claude/port.config.json. Stage sessions get it once the PR merges.'

export const ALLOW_RULE_LABEL = 'Rule'

export const ALLOW_CONFIRM_LABEL = 'Open allow PR'

export const ALLOW_PENDING = 'Opening the allow PR…'

export const ALLOW_DISMISS_PENDING = 'Dismissing the denial…'

export const ALLOW_DISMISSED_TOAST = 'Dismissed the denial.'

export function allowProposedTitle(number: number, rule: string): string {
  return `Opened PR#${String(number)} to allow ${rule}. Merge it to apply.`
}

export function allowAlreadyProposedTitle(number: number, rule: string): string {
  return `PR#${String(number)} already proposes ${rule}. Merge it to apply.`
}

export function allowAlreadyAllowedTitle(rule: string, integration: string): string {
  return `${rule} is already allowed on ${integration}.`
}

export function allowInvalidTitle(rule: string, reason: string): string {
  return `Couldn't allow ${rule}: ${reason}.`
}

export function allowFailedTitle(step: string, message: string): string {
  return `Couldn't open the allow PR (${step}): ${message}`
}

export const ALLOW_UNKNOWN_DENIAL = "That denial isn't tracked any more."

export function restartedTitle(number: number | null): string {
  return `Restarted ${ticketRef(number)}.`
}

export function restartDirtyTitle(number: number | null): string {
  return `${ticketRef(number)}'s worktree has uncommitted changes. Resume it, or clean it up in Repositories → Worktrees.`
}

export function restartRemoveFailedTitle(number: number | null, message: string): string {
  return `Couldn't remove ${ticketRef(number)}'s worktree: ${message}.`
}

export function restartLabelRefusedTitle(number: number | null, reason: string): string {
  return `Couldn't put ${ticketRef(number)} back in the queue: ${reason}.`
}

export function notTrackedAsInterrupted(number: number | null): string {
  return `${ticketRef(number)} is no longer tracked as interrupted.`
}

export function forceDispatchedTitle(number: number): string {
  return `#${String(number)} will dispatch on the next tick.`
}

export function notHeldTitle(number: number): string {
  return `#${String(number)} isn't held anymore. Nothing to force.`
}

export function notOwnedTitle(number: number): string {
  return `This app doesn't run that repository, so it can't dispatch #${String(number)}.`
}

export function resumedTitle(number: number): string {
  return `Resumed #${String(number)}.`
}

export function resumeAtCapacityTitle(limit: number): string {
  return `All ${String(limit)} session slots are busy. Close one, then resume.`
}

export function resumeNoSessionIdTitle(number: number): string {
  return `#${String(number)} ended before Claude started it, so there's nothing to resume.`
}

export function resumeStartFailedTitle(number: number, message: string): string {
  return `Couldn't resume #${String(number)}: ${message}.`
}

export function labelActionDoneTitle(action: 'retry' | 'refresh', shown: string): string {
  return `${action === 'retry' ? 'Retried' : 'Refreshed'} #${shown}.`
}

export function labelActionFailedTitle(action: 'retry' | 'refresh', shown: string, reason: string): string {
  return `Couldn't ${action} #${shown}: ${reason}.`
}

