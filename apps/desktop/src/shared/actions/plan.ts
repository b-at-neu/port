// Pure action derivation — decides whether an action applies and its label-level plan; `main/actions/apply.ts` turns a plan into a `LabelWriteRequest` and writes.
import { LABEL_DEFAULTS } from '../labels/defaults'
import type { LabelRole } from '../labels/defaults'
import type { LabelKey, LabelVocabulary } from '../labels/vocabulary'
import type { AssigneeExpectation, LabelAuditEntry, LabelPrecondition } from '../writes/types'
import type { ReconciledItem } from '../state/types'
import type { ActionAvailability, ActionPlan, ActionRefusal, OperatorAction } from './types'
import { RETRY_TRIGGER as ENGINE_RETRY_TRIGGER } from '../../../../../scripts/port-tick/liveness'

/** Reused directly from the tick engine's own `RETRY_TRIGGER`, so there is no second copy to drift; retry reads it forward, pause reads it inverted. */
export const RETRY_TRIGGER: Readonly<Partial<Record<LabelKey, LabelKey>>> = ENGINE_RETRY_TRIGGER

/** Inverse of `RETRY_TRIGGER`; a trigger with no inverse simply has no absent-key guard to add. */
const IN_FLIGHT_FOR_TRIGGER: Readonly<Partial<Record<LabelKey, LabelKey>>> = Object.fromEntries(
  Object.entries(RETRY_TRIGGER).map(([inFlight, trigger]) => [trigger, inFlight as LabelKey]),
)

/** Derived from `LABEL_DEFAULTS` so a new label is covered automatically. */
const ALL_STAGE_KEYS: readonly LabelKey[] = LABEL_DEFAULTS.filter((def) => def.role !== 'marker').map((def) => def.key)

/** Not imported from `shared/board/project.ts`'s equivalent to avoid a `shared/board` → `shared/actions` dependency neither module needs. */
export function stageKeyOf(item: Pick<ReconciledItem, 'stage' | 'stages'>): LabelKey | null {
  if (item.stage === null) return null
  return item.stages.find((label) => label.role === item.stage)?.key ?? null
}

function notApplicable(): ActionAvailability {
  return { available: false, reason: 'not-applicable' }
}

/** Called only after ownership has already passed, so `item.assignees` is always `[]` or exactly `[viewer]`. */
function assigneeHalf(item: Pick<ReconciledItem, 'assignees'>, viewer: string): { readonly addAssignees: readonly string[]; readonly assignees: AssigneeExpectation } {
  if (item.assignees.length === 0) return { addAssignees: [viewer], assignees: { kind: 'unassigned' } }
  return { addAssignees: [], assignees: { kind: 'exactly', logins: [viewer] } }
}

function recoveryPlan(action: OperatorAction, precondition: LabelPrecondition, add: readonly LabelKey[], remove: readonly LabelKey[], addAssignees: readonly string[]): ActionPlan {
  return { add, remove, addAssignees, removeAssignees: [], expect: precondition, action }
}

function pausePlan(item: ReconciledItem, viewer: string): ActionAvailability {
  if (item.stage !== 'trigger') return notApplicable()
  const trigger = stageKeyOf(item)
  if (trigger === null) return notApplicable()
  const guard = IN_FLIGHT_FOR_TRIGGER[trigger]
  const { addAssignees, assignees } = assigneeHalf(item, viewer)
  const precondition: LabelPrecondition = { present: [trigger], absent: guard !== undefined ? [guard] : [], assignees }
  return { available: true, plan: recoveryPlan('pause', precondition, [], [trigger], addAssignees) }
}

/** `add: []` is deliberate — the recovered trigger needs the audit log, which this pure module never reads; `main/actions/apply.ts` fills it in before writing. */
function resumePlan(item: ReconciledItem, viewer: string): ActionAvailability {
  if (!item.marked || item.stage !== null) return notApplicable()
  const { addAssignees, assignees } = assigneeHalf(item, viewer)
  const precondition: LabelPrecondition = { present: [], absent: ALL_STAGE_KEYS, assignees }
  return { available: true, plan: recoveryPlan('resume', precondition, [], [], addAssignees) }
}

function retryPlan(item: ReconciledItem, viewer: string): ActionAvailability {
  if (item.stage !== 'in-flight') return notApplicable()
  const inFlight = stageKeyOf(item)
  if (inFlight === null) return notApplicable()
  const trigger = RETRY_TRIGGER[inFlight]
  if (trigger === undefined) return notApplicable()
  const { addAssignees, assignees } = assigneeHalf(item, viewer)
  const precondition: LabelPrecondition = { present: [inFlight], absent: [trigger], assignees }
  return { available: true, plan: recoveryPlan('retry', precondition, [trigger], [inFlight], addAssignees) }
}

/** Unlike `retryPlan`, `add: []` stays empty — stop takes the item off the pipeline entirely until `resume` brings it back, with no trigger label to race against. */
function stopPlan(item: ReconciledItem, viewer: string): ActionAvailability {
  if (item.stage !== 'in-flight') return notApplicable()
  const inFlight = stageKeyOf(item)
  if (inFlight === null) return notApplicable()
  const { addAssignees, assignees } = assigneeHalf(item, viewer)
  const precondition: LabelPrecondition = { present: [inFlight], absent: [], assignees }
  return { available: true, plan: recoveryPlan('stop', precondition, [], [inFlight], addAssignees) }
}

/** Deliberately not ownership-gated: gate is protective and convergent, and refusing it on ownership would leave a pull request merging ungated. */
function gatePlan(item: ReconciledItem, approvalGate: boolean): ActionAvailability {
  if (!approvalGate) return notApplicable()
  if (item.kind !== 'pull-request') return notApplicable()
  if (item.marked || item.stages.length === 0) return notApplicable()
  const precondition: LabelPrecondition = { present: [], absent: ['marker'], assignees: { kind: 'any' } }
  return { available: true, plan: recoveryPlan('gate', precondition, ['marker'], [], []) }
}

/** Available only for a pull request at a trigger or terminal stage, with
 *  no in-flight label, gate label, `refreshBranch` or `refreshing` present. */
function refreshPlan(item: ReconciledItem, viewer: string): ActionAvailability {
  if (item.kind !== 'pull-request') return notApplicable()
  if (item.stage !== 'trigger' && item.stage !== 'terminal') return notApplicable()
  const blocking: LabelRole[] = ['in-flight', 'gate']
  if (item.stages.some((label) => blocking.includes(label.role) || label.key === 'refreshBranch' || label.key === 'refreshing')) return notApplicable()
  const { addAssignees, assignees } = assigneeHalf(item, viewer)
  const precondition: LabelPrecondition = { present: item.stages.map((label) => label.key), absent: ['refreshBranch', 'refreshing'], assignees }
  return { available: true, plan: recoveryPlan('refresh', precondition, ['refreshBranch'], [], addAssignees) }
}

export interface ActionsForParams {
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
  const { item, viewer, approvalGate } = params
  if (viewer === null) return refusedRecovery('viewer-unknown', item, approvalGate)
  if (!(item.assignees.length === 0 || (item.assignees.length === 1 && item.assignees[0] === viewer))) return refusedRecovery('not-owned', item, approvalGate)
  return {
    pause: pausePlan(item, viewer),
    resume: resumePlan(item, viewer),
    retry: retryPlan(item, viewer),
    stop: stopPlan(item, viewer),
    gate: gatePlan(item, approvalGate),
    refresh: refreshPlan(item, viewer),
  }
}

/** Inverse of `pausePlan`'s `expect.present`: returns the removed `LabelKey`, or `null` when the
 *  precondition shape does not match a pause. */
export function pausedTriggerFrom(entry: Pick<LabelAuditEntry, 'precondition'>, vocabulary: LabelVocabulary): LabelKey | null {
  const present = entry.precondition?.present ?? []
  if (present.length !== 1) return null
  const name = present[0]
  return vocabulary.labels.find((label) => label.name === name)?.key ?? null
}
