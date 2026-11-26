// Pure action derivation — decides whether an action applies and the move it makes; `main/pipeline/operator/apply.ts` turns the move into a ticket event and writes.
import type { ReconciledItem } from '@/types/state'
import type { ActionAvailability, ActionPlan, ActionRefusal, OperatorAction, OperatorMove } from '@/types/actions'
import type { TicketView } from '@/utils/pipeline/stages'

function notApplicable(): ActionAvailability {
  return { available: false, reason: 'not-applicable' }
}

function available(move: OperatorMove | null, addAssignees: readonly string[]): ActionAvailability {
  const plan: ActionPlan = { move, addAssignees }
  return { available: true, plan }
}

/** Called only after ownership has already passed, so `item.assignees` is always `[]` or exactly `[viewer]`. */
function addAssigneesOf(item: Pick<ReconciledItem, 'assignees'>, viewer: string): readonly string[] {
  return item.assignees.length === 0 ? [viewer] : []
}

function pausePlan(view: TicketView | null, paused: boolean, assign: readonly string[]): ActionAvailability {
  const kind = view?.status.kind
  return kind === 'queued' || (kind === 'held' && !paused) ? available({ kind: 'pause' }, assign) : notApplicable()
}

/** Only a paused ticket offers resume; the view's `held` cannot tell a pause from another hold, so the item's record says. */
function resumePlan(view: TicketView | null, paused: boolean, assign: readonly string[]): ActionAvailability {
  return view?.status.kind === 'held' && paused ? available({ kind: 'resume' }, assign) : notApplicable()
}

function runningPlan(view: TicketView | null, move: 'retry' | 'stop', assign: readonly string[]): ActionAvailability {
  return view?.status.kind === 'running' ? available({ kind: move }, assign) : notApplicable()
}

/** Deliberately not ownership-gated: gate is protective and convergent, and refusing it on ownership would leave a pull request merging ungated. */
function gatePlan(item: ReconciledItem, approvalGate: boolean): ActionAvailability {
  if (!approvalGate) return notApplicable()
  if (item.kind !== 'pull-request') return notApplicable()
  if (item.marked || item.stages.length === 0) return notApplicable()
  return available(null, [])
}

/** A pull request waiting its turn at review or revise, or an approved one waiting on the merge. */
function refreshPlan(view: TicketView | null, item: ReconciledItem, assign: readonly string[]): ActionAvailability {
  if (item.kind !== 'pull-request' || view === null) return notApplicable()
  const { stage, status } = view
  const waits = (stage === 'review' || stage === 'revise') && status.kind === 'queued'
  const approved = stage === 'merge' && status.kind === 'waiting-on-you' && status.gate === 'merge'
  return waits || approved ? available({ kind: 'refresh' }, assign) : notApplicable()
}

export interface ActionsForParams {
  readonly view: TicketView | null
  readonly item: ReconciledItem
  readonly viewer: string | null
  readonly approvalGate: boolean
}

/** Every action's availability for one item. `gate` runs its own ownership-free check; the rest refuse `not-owned` for any assignee set that is not empty or exactly `[viewer]`. */
function refusedRecovery(reason: ActionRefusal, item: ReconciledItem, approvalGate: boolean): Readonly<Record<OperatorAction, ActionAvailability>> {
  const refused: ActionAvailability = { available: false, reason }
  return { pause: refused, resume: refused, retry: refused, stop: refused, gate: gatePlan(item, approvalGate), refresh: refused }
}

export function actionsFor(params: ActionsForParams): Readonly<Record<OperatorAction, ActionAvailability>> {
  const { view, item, viewer, approvalGate } = params
  if (viewer === null) return refusedRecovery('viewer-unknown', item, approvalGate)
  if (!(item.assignees.length === 0 || (item.assignees.length === 1 && item.assignees[0] === viewer))) return refusedRecovery('not-owned', item, approvalGate)
  const assign = addAssigneesOf(item, viewer)
  const paused = item.ticket?.status.kind === 'held' && item.ticket.status.on === 'paused'
  return {
    pause: pausePlan(view, paused, assign),
    resume: resumePlan(view, paused, assign),
    retry: runningPlan(view, 'retry', assign),
    stop: runningPlan(view, 'stop', assign),
    gate: gatePlan(item, approvalGate),
    refresh: refreshPlan(view, item, assign),
  }
}
