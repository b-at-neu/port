// `actionFor` resolves each row's single inline action; `runAction`
// dispatches it, one switch over `NeedsYouItem.kind`.
import type { DecisionRefusal } from '../../../shared/actions/types'
import type { NeedsYouItem } from '../../../shared/board/needs-you'
import { openReviewDialog } from '../gate/controller'
import { openDecision } from '../decision/controller'
import { openAllowDialog } from './allow-dialog'
import { openRestartDialog } from './restart-dialog'
import { router } from '../router/router'
import { ROUTE_IDS } from '../router/routes'
import { invoke } from '../data/invoke'

export type NeedsYouActionKind = 'review-plan' | 'open' | 'unblock' | 'retry' | 'refresh' | 'answer' | 'allow' | 'resume' | 'restart'

export interface NeedsYouAction {
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
      return "There's an open rebase escalation this app can't record a decision against."
    case 'not-applicable':
      return "This action doesn't apply here."
  }
}

function unblockAction(item: Extract<NeedsYouItem, { readonly kind: 'needs-human' | 'blocked' }>): NeedsYouAction {
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
  return { label: 'Open ticket', kind: 'open', disabledReason: null }
}

export function actionFor(item: NeedsYouItem): NeedsYouAction {
  switch (item.kind) {
    case 'plan-review':
      return { label: 'Review plan', kind: 'review-plan', disabledReason: null }
    case 'ready-to-merge':
      return { label: 'Open PR', kind: 'open', disabledReason: null }
    case 'needs-human':
    case 'blocked':
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
    case 'stage-blocked':
      return { label: 'Open session', kind: 'open', disabledReason: null }
    case 'stage-denial':
      return { label: 'Allow from now on', kind: 'allow', disabledReason: null }
    case 'stage-interrupted':
      return { label: 'Resume', kind: 'resume', disabledReason: item.interrupted.claudeSessionId === null ? "This session ended before Claude started it, so there's nothing to resume." : null, secondaryLabel: 'Restart' }
  }
}

export interface RunActionDeps {
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
      if (item.kind === 'stage-questions' || item.kind === 'stage-blocked') {
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
    case 'resume':
      if (item.kind === 'stage-interrupted') void runStageResume(item.interrupted.id, item.interrupted.number, deps)
      return
    case 'restart':
      if (item.kind === 'stage-interrupted') openRestartDialog(item.interrupted)
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
  void deps
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

async function runLabelAction(item: NeedsYouItem, action: 'retry' | 'refresh', deps: RunActionDeps): Promise<void> {
  if (item.repoId === null || item.number === null) return
  const kind = item.matchedRow?.item.kind ?? 'pull-request'
  const expectedStage = item.matchedRow?.stageLabel?.key ?? null
  try {
    const result = await window.port.itemAction({ repoId: item.repoId, kind, number: item.number, action, expectedStage })
    deps.onToast(result.ok ? `${action === 'retry' ? 'Retried' : 'Refreshed'} #${String(item.number)}.` : `Couldn't ${action} #${String(item.number)}: ${result.reason}.`)
  } catch (error) {
    console.error(`Failed to reach the main process while applying ${action}`, error)
    deps.onToast(`Couldn't reach the main process to ${action} #${String(item.number)}.`)
  }
}
