// What each Needs you row offers, where a click goes, and how each write's result reads.
import type { DecisionRefusal, ItemActionResult } from '@/types/actions'
import type { NeedsYouItem } from '@/types/board'
import type { SessionKey } from '@/types/hosting'
import type { ActionInput } from '@/types/ipc'
import type { HeldForceDispatchResult } from '@/types/dispatch'
import type { InterruptedStage, StageAllowResult, StageDenial, StageRestartResult, StageResumeResult } from '@/types/stage'
import type { ActionToast } from '@/types/toast'
import type { ConfirmSpec } from '@/renderer/components/confirm-dialog'
import type { openDecision } from '@/renderer/decision/controller'
import { DECISION_BUTTON_LABELS } from '@/renderer/board/copy'
import { ticketViewOfItem } from '@/utils/pipeline/stages'
import {
  ACTION_LABELS,
  ALLOW_DISMISSED_TOAST,
  ALLOW_UNKNOWN_DENIAL,
  APPROVAL_GONE_TOAST,
  DECISION_REFUSAL_COPY,
  NOT_RUNNING_REPO_REASON,
  NO_SESSION_ID_REASON,
  OPEN_SESSION_LABEL,
  REFRESH_LABEL,
  REVISE_CYCLE_CAP_REASON,
  RESTART_CONFIRM_LABEL,
  UNREADABLE_STATE_REASON,
  allowAlreadyAllowedTitle,
  allowAlreadyProposedTitle,
  allowFailedTitle,
  allowInvalidTitle,
  allowProposedTitle,
  approvedEditToast,
  deniedEditToast,
  forceDispatchedTitle,
  labelActionDoneTitle,
  labelActionFailedTitle,
  labelOf,
  notHeldTitle,
  notOwnedTitle,
  notTrackedAsInterrupted,
  resumeAllDisabledReason,
  resumeAllToast,
  resumeAtCapacityTitle,
  resumeNoSessionIdTitle,
  resumeStartFailedTitle,
  resumedTitle,
  restartDescription,
  restartDirtyTitle,
  restartLabelRefusedTitle,
  restartRemoveFailedTitle,
  restartTitle,
  restartedTitle,
  refreshedToast,
} from '@/renderer/needs-you/copy'

type NeedsYouActionKind = 'review-plan' | 'open' | 'unblock' | 'grant' | 'retry' | 'refresh' | 'answer' | 'approve' | 'allow' | 'resume' | 'resume-all' | 'force' | 'copy-path'

export interface NeedsYouAction {
  readonly label: string
  readonly kind: NeedsYouActionKind
  readonly disabledReason: string | null
  readonly secondaryLabel?: string
  readonly secondaryDisabledReason?: string | null
}

type KindOf<K extends NeedsYouItem['kind']> = Extract<NeedsYouItem, { readonly kind: K }>

const STALE_AFTER_MS = 5 * 60_000

function reviseDisabledReason(reason: DecisionRefusal): string {
  return reason === 'cycle-cap' ? REVISE_CYCLE_CAP_REASON : DECISION_REFUSAL_COPY[reason]
}

function readyToMergeAction(item: KindOf<'ready-to-merge'>): NeedsYouAction {
  const open = { label: ACTION_LABELS.openPr, kind: 'open', disabledReason: null } as const
  const revise = item.row.decisions.revise
  if (revise.available) return { ...open, secondaryLabel: DECISION_BUTTON_LABELS.revise, secondaryDisabledReason: null }
  if (revise.reason === 'not-applicable') return open
  return { ...open, secondaryLabel: DECISION_BUTTON_LABELS.revise, secondaryDisabledReason: reviseDisabledReason(revise.reason) }
}

function unblockAction(item: KindOf<'needs-human' | 'blocked'>): NeedsYouAction {
  const decision = item.matchedRow?.decisions.unblock
  if (decision === undefined) return { label: ACTION_LABELS.unblock, kind: 'unblock', disabledReason: UNREADABLE_STATE_REASON }
  return { label: ACTION_LABELS.unblock, kind: 'unblock', disabledReason: decision.available ? null : DECISION_REFUSAL_COPY[decision.reason] }
}

function heldAction(item: KindOf<'held'>): NeedsYouAction {
  if (item.held.reason === 'conflicting') return { label: REFRESH_LABEL, kind: 'refresh', disabledReason: null }
  if (item.held.reason === 'cycle-cap') {
    const decision = item.matchedRow?.decisions.grant
    const disabledReason = decision === undefined ? UNREADABLE_STATE_REASON : decision.available ? null : DECISION_REFUSAL_COPY[decision.reason]
    return { label: DECISION_BUTTON_LABELS.grant, kind: 'grant', disabledReason, secondaryLabel: ACTION_LABELS.openPr, secondaryDisabledReason: null }
  }
  if (item.held.reason === 'contended') return { label: ACTION_LABELS.dispatchAnyway, kind: 'force', disabledReason: item.owner === 'app' ? null : NOT_RUNNING_REPO_REASON }
  return { label: ACTION_LABELS.openTicket, kind: 'open', disabledReason: null }
}

function resumeAllAction(item: KindOf<'usage-limit'>, now: Date): NeedsYouAction {
  const waiting = item.resetsAt !== null && Date.parse(item.resetsAt) > now.getTime()
  return { label: ACTION_LABELS.resumeAll, kind: 'resume-all', disabledReason: waiting && item.resetsAt !== null ? resumeAllDisabledReason(item.resetsAt) : null }
}

function interruptedAction(item: KindOf<'stage-interrupted'>): NeedsYouAction {
  if (item.interrupted.reason === 'cleanup-failed') return { label: ACTION_LABELS.copyPath, kind: 'copy-path', disabledReason: null }
  return { label: ACTION_LABELS.resume, kind: 'resume', disabledReason: item.interrupted.claudeSessionId === null ? NO_SESSION_ID_REASON : null, secondaryLabel: ACTION_LABELS.restart }
}

export function actionFor(item: NeedsYouItem, now: Date = new Date()): NeedsYouAction {
  switch (item.kind) {
    case 'plan-review':
      return { label: ACTION_LABELS.reviewPlan, kind: 'review-plan', disabledReason: null }
    case 'ready-to-merge':
      return readyToMergeAction(item)
    case 'needs-human':
    case 'blocked':
      return unblockAction(item)
    case 'budget':
      return { label: ACTION_LABELS.openTicket, kind: 'open', disabledReason: null }
    case 'held':
      return heldAction(item)
    case 'stalled':
      return { label: ACTION_LABELS.retry, kind: 'retry', disabledReason: null }
    case 'stage-question':
      return { label: ACTION_LABELS.answer, kind: 'answer', disabledReason: null }
    case 'stage-questions':
      return { label: OPEN_SESSION_LABEL, kind: 'open', disabledReason: null }
    case 'stage-approval':
      return { label: ACTION_LABELS.approve, kind: 'approve', disabledReason: null, secondaryLabel: ACTION_LABELS.deny }
    case 'stage-denial':
      return { label: ACTION_LABELS.allow, kind: 'allow', disabledReason: null }
    case 'stage-interrupted':
      return interruptedAction(item)
    case 'usage-limit':
      return resumeAllAction(item, now)
    case 'half-labelled':
      return { label: ACTION_LABELS.openOnGitHub, kind: 'open', disabledReason: null }
    case 'dispatch-failed':
      return { label: ACTION_LABELS.openTicket, kind: 'open', disabledReason: null }
  }
}

type DecisionRequest = Parameters<typeof openDecision>[0]

export type NeedsYouIntent =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'session'; readonly sessionKey: SessionKey }
  | { readonly kind: 'review-plan'; readonly repoId: NonNullable<NeedsYouItem['repoId']>; readonly number: number }
  | { readonly kind: 'decision'; readonly request: DecisionRequest }
  | { readonly kind: 'expand' }
  | { readonly kind: 'allow'; readonly repoId: NonNullable<NeedsYouItem['repoId']>; readonly denial: StageDenial }
  | { readonly kind: 'approve'; readonly decision: 'allow-once' | 'deny'; readonly sessionKey: SessionKey; readonly permissionId: string; readonly path: string }
  | { readonly kind: 'resume'; readonly id: string; readonly number: number }
  | { readonly kind: 'resume-all'; readonly entries: readonly InterruptedStage[] }
  | { readonly kind: 'restart'; readonly id: string }
  | { readonly kind: 'copy-path'; readonly path: string; readonly label: string }
  | { readonly kind: 'force'; readonly repoId: NonNullable<NeedsYouItem['repoId']>; readonly number: number }
  | { readonly kind: 'label'; readonly action: 'retry' | 'refresh'; readonly input: ActionInput<'item.action'>; readonly shown: string }

function decisionIntent(item: NeedsYouItem, decision: 'unblock' | 'grant' | 'revise'): NeedsYouIntent | null {
  const row = item.kind === 'ready-to-merge' ? item.row : item.matchedRow
  if (row === null || item.repoId === null || item.number === null) return null
  const availability = row.decisions[decision]
  if (!availability.available) return null
  return { kind: 'decision', request: { repoId: item.repoId, number: item.number, decision, expected: ticketViewOfItem(row.item), context: availability.context } }
}

function labelIntent(item: NeedsYouItem, action: 'retry' | 'refresh'): NeedsYouIntent | null {
  if (item.repoId === null || item.number === null) return null
  const kind = item.matchedRow?.item.kind ?? 'pull-request'
  const expected = item.matchedRow === null ? null : ticketViewOfItem(item.matchedRow.item)
  return { kind: 'label', action, input: { repoId: item.repoId, kind, number: item.number, action, expected },shown: String(item.ticket?.number ?? item.number) }
}

/** The primary click's intent, or `null` when the action is disabled or has nothing to act on. */
export function intentOf(item: NeedsYouItem, now: Date = new Date()): NeedsYouIntent | null {
  const action = actionFor(item, now)
  if (action.disabledReason !== null) return null
  switch (action.kind) {
    case 'review-plan':
      return item.repoId !== null && item.number !== null ? { kind: 'review-plan', repoId: item.repoId, number: item.number } : null
    case 'unblock':
    case 'grant':
      return decisionIntent(item, action.kind)
    case 'open':
      if (item.kind === 'stage-questions') return { kind: 'session', sessionKey: item.sessionKey }
      return item.url === null ? null : { kind: 'url', url: item.url }
    case 'answer':
      return { kind: 'expand' }
    case 'allow':
      return item.kind === 'stage-denial' && item.repoId !== null ? { kind: 'allow', repoId: item.repoId, denial: item.denial } : null
    case 'approve':
      return item.kind === 'stage-approval' ? { kind: 'approve', decision: 'allow-once', sessionKey: item.sessionKey, permissionId: item.permissionId, path: item.path } : null
    case 'resume':
      return item.kind === 'stage-interrupted' ? { kind: 'resume', id: item.interrupted.id, number: item.interrupted.number } : null
    case 'resume-all':
      return item.kind === 'usage-limit' ? { kind: 'resume-all', entries: item.entries } : null
    case 'copy-path':
      return item.kind === 'stage-interrupted' ? { kind: 'copy-path', path: item.interrupted.worktree.path, label: labelOf(item) } : null
    case 'force':
      return item.kind === 'held' && item.repoId !== null && item.number !== null ? { kind: 'force', repoId: item.repoId, number: item.number } : null
    case 'retry':
    case 'refresh':
      return labelIntent(item, action.kind)
  }
}

/** Restart, Deny, Open PR on a cycle-capped held row, or the revise decision. */
export function secondaryIntentOf(item: NeedsYouItem, now: Date = new Date()): NeedsYouIntent | null {
  const action = actionFor(item, now)
  if (action.secondaryLabel === undefined || action.secondaryDisabledReason != null) return null
  switch (item.kind) {
    case 'stage-interrupted':
      return action.kind === 'resume' ? { kind: 'restart', id: item.interrupted.id } : null
    case 'stage-approval':
      return { kind: 'approve', decision: 'deny', sessionKey: item.sessionKey, permissionId: item.permissionId, path: item.path }
    case 'held':
      return action.kind === 'grant' && item.url !== null ? { kind: 'url', url: item.url } : null
    case 'ready-to-merge':
      return decisionIntent(item, 'revise')
    default:
      return null
  }
}

export function hasDetail(item: NeedsYouItem): boolean {
  switch (item.kind) {
    case 'held':
      return item.held.reason === 'contended' && item.held.contention !== null
    case 'usage-limit':
    case 'stage-question':
    case 'stage-denial':
    case 'stage-approval':
    case 'dispatch-failed':
      return true
    case 'stage-interrupted':
      return item.interrupted.reason === 'cleanup-failed'
    default:
      return false
  }
}

export function emptyStateOf(state: { readonly scoped: boolean; readonly dismissedCount: number; readonly dismissedShown: boolean }): 'show-dismissed' | 'scoped' | 'all' {
  if (state.dismissedCount > 0 && !state.dismissedShown) return 'show-dismissed'
  return state.scoped ? 'scoped' : 'all'
}

/** The age in ms once the data is more than five minutes old, otherwise `null`. */
export function staleForMs(dataUpdatedAt: number, now: Date): number | null {
  if (dataUpdatedAt <= 0) return null
  const age = now.getTime() - dataUpdatedAt
  return age > STALE_AFTER_MS ? age : null
}

export function findInterrupted(items: readonly NeedsYouItem[], id: string): InterruptedStage | undefined {
  for (const item of items) if (item.kind === 'stage-interrupted' && item.interrupted.id === id) return item.interrupted
  return undefined
}

export function findHeld(items: readonly NeedsYouItem[], repoId: string, number: number): KindOf<'held'> | undefined {
  for (const item of items) if (item.kind === 'held' && item.repoId === repoId && item.number === number) return item
  return undefined
}

function toast(tone: ActionToast['tone'], title: string, action: ActionToast['action'] = null): ActionToast {
  return { tone, title, description: null, action, cancel: null }
}

export function refreshedToastOf(count: number): ActionToast {
  return toast('success', refreshedToast(count))
}

export function dismissedDenialToast(): ActionToast {
  return toast('success', ALLOW_DISMISSED_TOAST)
}

export function restartToastOf(number: number | null, result: StageRestartResult): ActionToast {
  switch (result.kind) {
    case 'ok':
      return toast('success', restartedTitle(number))
    case 'worktree-dirty':
      return toast('error', restartDirtyTitle(number))
    case 'worktree-remove-failed':
      return toast('error', restartRemoveFailedTitle(number, result.message))
    case 'label-refused':
      return toast('error', restartLabelRefusedTitle(number, result.reason))
    case 'unknown-stage':
      return toast('info', notTrackedAsInterrupted(number))
  }
}

export function forceDispatchToastOf(number: number, result: HeldForceDispatchResult): ActionToast {
  switch (result.kind) {
    case 'ok':
      return toast('success', forceDispatchedTitle(number))
    case 'not-held':
      return toast('info', notHeldTitle(number))
    case 'not-owned':
      return toast('error', notOwnedTitle(number))
  }
}

export function allowToastOf(rule: string, result: StageAllowResult, openUrl: (url: string) => void): ActionToast {
  const openPr = (url: string) => ({ label: ACTION_LABELS.openPr, onClick: () => openUrl(url) })
  switch (result.kind) {
    case 'proposed':
      return toast('success', allowProposedTitle(result.number, rule), openPr(result.url))
    case 'already-proposed':
      return toast('info', allowAlreadyProposedTitle(result.number, rule), openPr(result.url))
    case 'already-allowed':
      return toast('info', allowAlreadyAllowedTitle(rule, result.integration))
    case 'invalid-rule':
      return toast('error', allowInvalidTitle(rule, result.reason))
    case 'failed':
      return toast('error', allowFailedTitle(result.step, result.message))
    case 'unknown-denial':
      return toast('info', ALLOW_UNKNOWN_DENIAL)
  }
}

export function resumeToastOf(number: number, result: StageResumeResult): ActionToast {
  switch (result.kind) {
    case 'ok':
      return toast('success', resumedTitle(number))
    case 'at-capacity':
      return toast('error', resumeAtCapacityTitle(result.limit))
    case 'no-session-id':
      return toast('error', resumeNoSessionIdTitle(number))
    case 'start-failed':
      return toast('error', resumeStartFailedTitle(number, result.message))
    case 'unknown-stage':
      return toast('info', notTrackedAsInterrupted(number))
  }
}

export function labelActionToastOf(action: 'retry' | 'refresh', shown: string, result: ItemActionResult): ActionToast {
  return result.ok ? toast('success', labelActionDoneTitle(action, shown)) : toast('error', labelActionFailedTitle(action, shown, result.reason))
}

export function approvalToastOf(decision: 'allow-once' | 'deny', path: string, result: { readonly ok: boolean }): ActionToast {
  if (!result.ok) return toast('info', APPROVAL_GONE_TOAST)
  return toast('success', decision === 'deny' ? deniedEditToast(path) : approvedEditToast(path))
}

export function restartConfirm(interrupted: InterruptedStage | undefined): ConfirmSpec {
  const number = interrupted?.number ?? null
  return { title: restartTitle(interrupted?.agent ?? '', number), description: restartDescription(number), confirmLabel: RESTART_CONFIRM_LABEL, tone: 'destructive' }
}

export interface ResumeTally {
  readonly resumed: number
  readonly attempted: number
  readonly total: number
}

export type ResumeAllStep = { readonly kind: 'continue'; readonly tally: ResumeTally } | { readonly kind: 'stop'; readonly toast: ActionToast }

/** One entry's result folded into the running tally; a full house or a failure stops the loop with the summary. */
export function resumeAllStep(tally: ResumeTally, result: StageResumeResult, number: number): ResumeAllStep {
  switch (result.kind) {
    case 'unknown-stage':
      return { kind: 'continue', tally }
    case 'ok':
      return { kind: 'continue', tally: { ...tally, resumed: tally.resumed + 1, attempted: tally.attempted + 1 } }
    case 'at-capacity':
      return { kind: 'stop', toast: toast('error', resumeAllToast(tally.resumed, tally.total, result.limit, null)) }
    case 'no-session-id':
      return { kind: 'stop', toast: toast('error', resumeAllToast(tally.resumed, tally.total, null, { number, reason: 'it ended before Claude started it' })) }
    case 'start-failed':
      return { kind: 'stop', toast: toast('error', resumeAllToast(tally.resumed, tally.total, null, { number, reason: result.message })) }
  }
}

export function resumeAllDoneToast(tally: ResumeTally): ActionToast {
  return toast('success', resumeAllToast(tally.resumed, tally.attempted, null, null))
}
