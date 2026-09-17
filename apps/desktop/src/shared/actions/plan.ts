// Pure action derivation (#94) — no `gh`, no filesystem, no audit log. This
// module decides *whether* an action applies and what its label-level plan
// is; `main/actions/apply.ts` is the only caller that turns a plan into a
// `LabelWriteRequest` and actually writes.
import { LABEL_DEFAULTS } from '../labels/defaults'
import type { LabelKey, LabelVocabulary } from '../labels/vocabulary'
import type { AssigneeExpectation, AuditEntry, LabelPrecondition } from '../writes/types'
import type { ReconciledItem } from '../state/types'
import type { ActionAvailability, ActionPlan, ActionRefusal, OperatorAction } from './types'

/** The retry mapping from an in-flight label back to its trigger label,
 *  transcribed byte-for-byte from `scripts/port-tick/liveness.mjs`'s own
 *  `RETRY_TRIGGER` — `scripts/checks/desktop-actions.mjs` pins this against
 *  that file, both directions, keys and values. Used in both directions:
 *  retry reads it forward, pause reads it inverted (`IN_FLIGHT_FOR_TRIGGER`
 *  below) to derive the one in-flight label whose presence means a stage
 *  already claimed the item. */
export const RETRY_TRIGGER: Readonly<Record<string, LabelKey>> = {
  planning: 'ready',
  inProgress: 'planApproved',
  reviewing: 'readyForReview',
  revising: 'needsRevision',
  refreshing: 'refreshBranch',
}

/** The inverse of `RETRY_TRIGGER` — not every trigger has an entry here
 *  (`planChangesRequested` dispatches into `planning` too, but `planning`'s
 *  own recovery target is `ready`, so there is no second key that maps back
 *  to it). A trigger with no inverse simply has no absent-key guard to add. */
const IN_FLIGHT_FOR_TRIGGER: Readonly<Partial<Record<LabelKey, LabelKey>>> = Object.fromEntries(
  Object.entries(RETRY_TRIGGER).map(([inFlight, trigger]) => [trigger, inFlight as LabelKey]),
)

/** Every `LabelKey` whose `LABEL_DEFAULTS` role is not `marker` — derived,
 *  never typed out, so a future label addition is covered automatically. */
const ALL_STAGE_KEYS: readonly LabelKey[] = LABEL_DEFAULTS.filter((def) => def.role !== 'marker').map((def) => def.key)

/** The winning `StageLabel`'s own key, `null` when the item carries no
 *  role-bearing label at all. Mirrors `shared/board/project.ts`'s
 *  `stageLabelOf`, but returns the bare key rather than the whole label —
 *  not imported from there to avoid a `shared/board` → `shared/actions`
 *  dependency neither module otherwise needs. Exported so
 *  `main/actions/apply.ts` can compare a fresh read against the renderer's
 *  own `expectedStage` with the same definition of "the item's stage". */
export function stageKeyOf(item: Pick<ReconciledItem, 'stage' | 'stages'>): LabelKey | null {
  if (item.stage === null) return null
  return item.stages.find((label) => label.role === item.stage)?.key ?? null
}

function notApplicable(): ActionAvailability {
  return { available: false, reason: 'not-applicable' }
}

/** The assignee half shared by pause/resume/retry — called only once
 *  ownership has already passed (`item.assignees` is therefore `[]` or
 *  exactly `[viewer]`), so this never has to consider `not-owned`. */
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

/** `add: []` is a deliberate placeholder — the recovered trigger is not
 *  knowable here, since resolving it means reading the audit log
 *  (`readAuditLog`/`pausedTriggerFrom`), an impure operation this pure
 *  module never performs. `main/actions/apply.ts` calls
 *  `recoverPausedTrigger` itself and fills `add` in before building the
 *  `LabelWriteRequest` — everything else about the plan (the absent-key
 *  guard, the assignee half) is already fully determined here. */
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

/** Deliberately not ownership-gated (plan's own **Implementation**): gate is
 *  protective and convergent, and refusing it on ownership would leave a
 *  pull request merging ungated because its owner is not looking. */
function gatePlan(item: ReconciledItem, approvalGate: boolean): ActionAvailability {
  if (!approvalGate) return notApplicable()
  if (item.kind !== 'pull-request') return notApplicable()
  if (item.marked || item.stages.length === 0) return notApplicable()
  const precondition: LabelPrecondition = { present: [], absent: ['marker'], assignees: { kind: 'any' } }
  return { available: true, plan: recoveryPlan('gate', precondition, ['marker'], [], []) }
}

export interface ActionsForParams {
  readonly item: ReconciledItem
  readonly viewer: string | null
  readonly approvalGate: boolean
}

/** Every action's availability for one item. Ownership is checked first for
 *  pause/resume/retry, so it can never be skipped: `viewer === null` refuses
 *  all three `viewer-unknown`; an assignee set that is neither empty nor
 *  exactly `[viewer]` refuses all three `not-owned` (PIPELINE.md's "exactly
 *  one assignee per in-flight pipeline item" — viewer-among-several is
 *  refused, not accepted). `gate` runs its own, ownership-free check. */
function refusedTriple(reason: ActionRefusal, item: ReconciledItem, approvalGate: boolean): Readonly<Record<OperatorAction, ActionAvailability>> {
  const refused: ActionAvailability = { available: false, reason }
  return { pause: refused, resume: refused, retry: refused, gate: gatePlan(item, approvalGate) }
}

export function actionsFor(params: ActionsForParams): Readonly<Record<OperatorAction, ActionAvailability>> {
  const { item, viewer, approvalGate } = params
  if (viewer === null) return refusedTriple('viewer-unknown', item, approvalGate)
  if (!(item.assignees.length === 0 || (item.assignees.length === 1 && item.assignees[0] === viewer))) return refusedTriple('not-owned', item, approvalGate)
  return { pause: pausePlan(item, viewer), resume: resumePlan(item, viewer), retry: retryPlan(item, viewer), gate: gatePlan(item, approvalGate) }
}

/** The inverse of `pausePlan`'s own `expect.present` — given a pause's own
 *  audit entry, returns the `LabelKey` it removed, or `null` when the
 *  precondition shape does not match a pause (exactly one `present` name,
 *  resolved back through the vocabulary's own resolved names, never a
 *  second name→key table). A unit test round-trips plan → entry → key so
 *  the two can never drift apart silently. */
export function pausedTriggerFrom(entry: Pick<AuditEntry, 'precondition'>, vocabulary: LabelVocabulary): LabelKey | null {
  const present = entry.precondition?.present ?? []
  if (present.length !== 1) return null
  const name = present[0]
  return vocabulary.labels.find((label) => label.name === name)?.key ?? null
}
