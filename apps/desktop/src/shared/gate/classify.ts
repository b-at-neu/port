// Pure plan-review-gate classification and label-level plan building — no `gh`, no filesystem. The caller supplies the already-fetched `GateClassifyItem`; this module never touches a body string.
import { labelName } from '../labels/vocabulary'
import type { LabelKey, LabelVocabulary } from '../labels/vocabulary'
import type { LabelPrecondition } from '../writes/types'
import type { PipelineItemKind } from '../github/types'
import type { GateDecision, GateVerdict } from './types'

export interface GateClassifyItem {
  readonly kind: PipelineItemKind
  readonly number: number
  readonly labels: readonly string[]
  readonly assignees: readonly string[]
  readonly viewer: string
  /** Computed by `main/actions/gate.ts` from the item's own body — this module never parses one. */
  readonly noPlanBlock: boolean
}

/** `item: null` passes through as `not-found`, never a thrown error. Resolves `planReview` through the vocabulary, never a literal name. `assignedElsewhere` is advisory only, never a refusal. */
export function classifyGate(params: { readonly item: GateClassifyItem | null; readonly vocabulary: LabelVocabulary }): GateVerdict {
  const { item, vocabulary } = params
  if (item === null) return { kind: 'not-found' }
  if (item.kind === 'pull-request') return { kind: 'not-an-issue' }

  const planReviewName = labelName(vocabulary, 'planReview')
  if (planReviewName === undefined || !item.labels.includes(planReviewName)) {
    return { kind: 'not-at-plan-review', observed: item.labels }
  }

  const assignedElsewhere = item.assignees.filter((login) => login !== item.viewer)
  return { kind: 'answerable', noPlanBlock: item.noPlanBlock, assignedElsewhere }
}

export interface GatePlan {
  readonly add: readonly LabelKey[]
  readonly remove: readonly LabelKey[]
  readonly expect: LabelPrecondition
}

/** Key-level plans only; the caller supplies `repoId`/`repo`/`kind`/`number`/`vocabulary`. `expect.assignees: { kind: 'any' }` is deliberate: an item assigned to someone else is still answerable. */
export function buildGatePlan(decision: GateDecision): GatePlan {
  const add: LabelKey = decision === 'approve' ? 'planApproved' : 'planChangesRequested'
  return {
    add: [add],
    remove: ['planReview'],
    expect: { present: ['planReview'], absent: ['planApproved', 'planChangesRequested'], assignees: { kind: 'any' } },
  }
}

/** The auto-plan swap's write plan — `add`/`remove` come from `buildGatePlan('approve')` unchanged. Its precondition is stricter: `present` requires both `planReview` and `autoPlan`, and `assignees` must exactly match the snapshot's own set. */
export function buildAutoApprovePlan(params: { readonly vocabulary: LabelVocabulary; readonly assignees: readonly string[] }): GatePlan {
  const { add, remove } = buildGatePlan('approve')
  const allRoleBearing = params.vocabulary.labels.filter((l) => l.role !== 'marker').map((l) => l.key)
  const absent = allRoleBearing.filter((key) => key !== 'planReview')
  return { add, remove, expect: { present: ['planReview', 'autoPlan'], absent, assignees: { kind: 'exactly', logins: params.assignees } } }
}
