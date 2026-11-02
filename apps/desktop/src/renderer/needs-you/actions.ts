// `actionFor` resolves each row's single inline action; `runAction`
// dispatches it, one switch over `NeedsYouItem.kind`.
import type { DecisionRefusal } from '@/types/actions'
import type { NeedsYouItem } from '@/types/board'
import type { InterruptedStage, StageResumeResult } from '@/types/stage'
import {
  APPROVAL_GONE_TOAST,
  APPROVAL_UNREACHABLE_TOAST,
  PROTECTED_EDIT_DENY_MESSAGE,
  approvedEditToast,
  copiedPathToast,
  copyPathFailedToast,
  deniedEditToast,
  resumeAllDisabledReason,
  resumeAllToast,
} from '@/renderer/needs-you/copy'
import { openReviewDialog } from '@/renderer/gate/controller'
import { openDecision } from '@/renderer/decision/controller'
import { openAllowDialog } from '@/renderer/needs-you/allow-dialog'
import { openRestartDialog } from '@/renderer/needs-you/restart-dialog'
import { openForceDispatchDialog } from '@/renderer/needs-you/force-dispatch-dialog'
import { router } from '@/renderer/router/router'
import { ROUTE_IDS } from '@/renderer/router/routes'
import { invoke } from '@/renderer/data/invoke'

type NeedsYouActionKind = 'review-plan' | 'open' | 'unblock' | 'retry' | 'refresh' | 'answer' | 'approve' | 'allow' | 'resume' | 'resume-all' | 'restart' | 'force' | 'copy-path'

interface NeedsYouAction {
  readonly label: string
  readonly kind: NeedsYouActionKind
  readonly disabledReason: string | null
  readonly secondaryLabel?: string
}

function disabledReasonCopy(reason: DecisionRefusal): string {
  switch (reason) {
    case 'viewer-unknown':
      return "Can't tell which account you're signed in as, so ownership can't be checked."
    case 'not-owned':
      return 'Someone else owns this item. Take it over in the cockpit before acting on it here.'
    case 'cycle-cap':
      return 'Already at the review cycle cap — unblocking would only escalate it straight back.'
    case 'rebase-decisions':
      return "This rebase escalation's decisions couldn't be read. Answer them with unblock #N in the cockpit."
    case 'not-applicable':
      return "This action doesn't apply here."
    case 'agent-live':
      return "This item's agent is still waiting in its session. Answer it there and it clears the block itself."
  }
}

function unblockAction(item: Extract<NeedsYouItem, { readonly kind: 'needs-human' }>): NeedsYouAction {
  const decision = item.matchedRow?.decisions.unblock
  if (decision === undefined) return { label: 'Unblock', kind: 'unblock', disabledReason: "Can't read this item's current state." }
  return { label: 'Unblock', kind: 'unblock', disabledReason: decision.available ? null : disabledReasonCopy(decision.reason) }
}

function heldAction(item: Extract<NeedsYouItem, { readonly kind: 'held' }>): NeedsYouAction {
  if (item.held.reason === 'conflicting') return { label: 'Refresh', kind: 'refresh', disabledReason: null }
  if (item.held.reason === 'cycle-cap') {
    const decision = item.matchedRow?.decisions.unblock
    if (decision?.available === true) return { label: 'Unblock', kind: 'unblock', disabledReason: null }
    return { label: 'Open PR', kind: 'open', disabledReason: null }
  }
  if (item.held.reason === 'contended') {
    const disabledReason = item.owner === 'app' ? null : 'The terminal cockpit runs this repository. Use `dispatch #N anyway` there.'
    return { label: 'Dispatch anyway', kind: 'force', disabledReason }
  }
  return { label: 'Open ticket', kind: 'open', disabledReason: null }
}

function resumeAllAction(item: Extract<NeedsYouItem, { readonly kind: 'usage-limit' }>, now: Date): NeedsYouAction {
  const waiting = item.resetsAt !== null && Date.parse(item.resetsAt) > now.getTime()
  return { label: 'Resume all', kind: 'resume-all', disabledReason: waiting && item.resetsAt !== null ? resumeAllDisabledReason(item.resetsAt) : null }
}

export function actionFor(item: NeedsYouItem, now: Date = new Date()): NeedsYouAction {
  switch (item.kind) {
    case 'plan-review':
      return { label: 'Review plan', kind: 'review-plan', disabledReason: null }
    case 'ready-to-merge':
      return { label: 'Open PR', kind: 'open', disabledReason: null }
    case 'needs-human':
      return unblockAction(item)
    case 'budget':
      return { label: 'Open ticket', kind: 'open', disabledReason: null }
    case 'held':
      return heldAction(item)
    case 'stalled':
      return { label: 'Retry', kind: 'retry', disabledReason: null }
    case 'stage-question':
      return { label: 'Answer', kind: 'answer', disabledReason: null }
    case 'stage-questions':
      return { label: 'Open session', kind: 'open', disabledReason: null }
    case 'stage-approval':
      return { label: 'Approve edit', kind: 'approve', disabledReason: null, secondaryLabel: 'Deny' }
    case 'stage-denial':
      return { label: 'Allow from now on', kind: 'allow', disabledReason: null }
    case 'stage-interrupted':
      if (item.interrupted.reason === 'cleanup-failed') return { label: 'Copy path', kind: 'copy-path', disabledReason: null }
      return { label: 'Resume', kind: 'resume', disabledReason: item.interrupted.claudeSessionId === null ? "This session ended before Claude started it, so there's nothing to resume." : null, secondaryLabel: 'Restart' }
    case 'usage-limit':
      return resumeAllAction(item, now)
    case 'half-labelled':
      return { label: 'Open on GitHub', kind: 'open', disabledReason: null }
    case 'dispatch-failed':
      return { label: 'Open ticket', kind: 'open', disabledReason: null }
  }
}

interface RunActionDeps {
  readonly onToast: (message: string) => void
}

/** The row's own click entry point: opens a dialog, opens the item's url,
 *  fires a single-label write reported as a toast, or expands the row. */
export function runAction(item: NeedsYouItem, deps: RunActionDeps): void {
  const action = actionFor(item)
  if (action.disabledReason !== null) return

  switch (action.kind) {
    case 'review-plan':
      if (item.repoId !== null && item.number !== null) openReviewDialog(item.repoId, item.number)
      return
    case 'unblock': {
      if (item.matchedRow === null || item.repoId === null || item.number === null) return
      const decision = item.matchedRow.decisions.unblock
      if (!decision.available) return
      openDecision({ repoId: item.repoId, number: item.number, decision: 'unblock', expectedStage: item.matchedRow.stageLabel?.key ?? null, context: decision.context })
      return
    }
    case 'open':
      if (item.kind === 'stage-questions') {
        void router.navigate({ to: ROUTE_IDS.session, search: { key: item.sessionKey } })
        return
      }
      if (item.url !== null) window.open(item.url, '_blank')
      return
    case 'answer':
      // Expands the row in place — the question card renders inline (`screen.tsx`'s own `hasDetail`).
      return
    case 'allow':
      if (item.kind === 'stage-denial' && item.repoId !== null) openAllowDialog(item.repoId, item.denial)
      return
    case 'approve':
      if (item.kind === 'stage-approval') void answerProtectedEdit(item, 'allow-once', deps)
      return
    case 'resume':
      if (item.kind === 'stage-interrupted') void runStageResume(item.interrupted.id, item.interrupted.number, deps)
      return
    case 'resume-all':
      if (item.kind === 'usage-limit') void runResumeAll(item.entries, deps)
      return
    case 'restart':
      if (item.kind === 'stage-interrupted') openRestartDialog(item.interrupted)
      return
    case 'copy-path':
      if (item.kind === 'stage-interrupted') void copyWorktreePath(item, deps)
      return
    case 'force':
      if (item.kind === 'held' && item.repoId !== null && item.number !== null) openForceDispatchDialog({ repoId: item.repoId, number: item.number, held: item.held })
      return
    case 'retry':
    case 'refresh':
      void runLabelAction(item, action.kind, deps)
  }
}

/** The Interrupted row's secondary action is Restart; its primary is Resume, handled here directly
 *  (never a confirmation — only Restart has DESIGN §4 consequences). */
export function runSecondaryAction(item: NeedsYouItem, deps: RunActionDeps): void {
  const action = actionFor(item)
  if (action.kind === 'resume' && item.kind === 'stage-interrupted') openRestartDialog(item.interrupted)
  if (action.kind === 'approve' && item.kind === 'stage-approval') void answerProtectedEdit(item, 'deny', deps)
}

async function answerProtectedEdit(item: Extract<NeedsYouItem, { readonly kind: 'stage-approval' }>, decision: 'allow-once' | 'deny', deps: RunActionDeps): Promise<void> {
  try {
    const result = await invoke('session:permission:answer', { sessionKey: item.sessionKey, permissionId: item.permissionId, decision, message: decision === 'deny' ? PROTECTED_EDIT_DENY_MESSAGE : null })
    if (!result.ok) deps.onToast(APPROVAL_GONE_TOAST)
    else deps.onToast(decision === 'deny' ? deniedEditToast(item.path) : approvedEditToast(item.path))
  } catch (error) {
    console.error('Failed to reach the main process while answering a protected edit', error)
    deps.onToast(APPROVAL_UNREACHABLE_TOAST)
  }
}

async function copyWorktreePath(item: Extract<NeedsYouItem, { readonly kind: 'stage-interrupted' }>, deps: RunActionDeps): Promise<void> {
  const path = item.interrupted.worktree.path
  try {
    await navigator.clipboard.writeText(path)
    deps.onToast(copiedPathToast(item))
  } catch (error) {
    console.error('Failed to copy the worktree path', error)
    deps.onToast(copyPathFailedToast(path))
  }
}

async function runStageResume(id: string, number: number, deps: RunActionDeps): Promise<void> {
  try {
    const result = await invoke('stage:resume', { id })
    switch (result.kind) {
      case 'ok':
        deps.onToast(`Resumed #${String(number)}.`)
        return
      case 'at-capacity':
        deps.onToast(`All ${String(result.limit)} session slots are busy. Close one, then resume.`)
        return
      case 'no-session-id':
        deps.onToast(`#${String(number)} ended before Claude started it, so there's nothing to resume.`)
        return
      case 'start-failed':
        deps.onToast(`Couldn't resume #${String(number)}: ${result.message}.`)
        return
      case 'unknown-stage':
        deps.onToast(`#${String(number)} is no longer tracked as interrupted.`)
    }
  } catch (error) {
    console.error('Failed to reach the main process while resuming a stage session', error)
    deps.onToast(`Couldn't reach the main process to resume #${String(number)}.`)
  }
}

function resumeFailureReason(result: Exclude<StageResumeResult, { readonly kind: 'ok' | 'at-capacity' | 'unknown-stage' }>): string {
  return result.kind === 'no-session-id' ? 'it ended before Claude started it' : result.message
}

/** Resumes one entry at a time, stopping at the first full house or failure so the one summary toast names what happened. */
async function runResumeAll(entries: readonly InterruptedStage[], deps: RunActionDeps): Promise<void> {
  let resumed = 0
  let attempted = 0
  try {
    for (const entry of entries) {
      const result = await invoke('stage:resume', { id: entry.id })
      if (result.kind === 'unknown-stage') continue
      attempted += 1
      if (result.kind === 'ok') {
        resumed += 1
        continue
      }
      if (result.kind === 'at-capacity') {
        deps.onToast(resumeAllToast(resumed, entries.length, result.limit, null))
        return
      }
      deps.onToast(resumeAllToast(resumed, entries.length, null, { number: entry.number, reason: resumeFailureReason(result) }))
      return
    }
    deps.onToast(resumeAllToast(resumed, attempted, null, null))
  } catch (error) {
    console.error('Failed to reach the main process while resuming usage-limit sessions', error)
    deps.onToast("Couldn't reach the main process to resume the waiting sessions.")
  }
}

async function runLabelAction(item: NeedsYouItem, action: 'retry' | 'refresh', deps: RunActionDeps): Promise<void> {
  if (item.repoId === null || item.number === null) return
  const kind = item.matchedRow?.item.kind ?? 'pull-request'
  const expectedStage = item.matchedRow?.stageLabel?.key ?? null
  const shown = String(item.ticket?.number ?? item.number)
  try {
    const result = await window.port.itemAction({ repoId: item.repoId, kind, number: item.number, action, expectedStage })
    deps.onToast(result.ok ? `${action === 'retry' ? 'Retried' : 'Refreshed'} #${shown}.` : `Couldn't ${action} #${shown}: ${result.reason}.`)
  } catch (error) {
    console.error(`Failed to reach the main process while applying ${action}`, error)
    deps.onToast(`Couldn't reach the main process to ${action} #${shown}.`)
  }
}
