// Pure plan-gate classification and label-level plan building — no `gh`, no
// filesystem. `classifyGate` never resolves a `gh` call itself; the caller
// (`main/actions/gate.ts`) supplies the already-fetched `GateClassifyItem`,
// with `noPlanBlock` already computed from the body split at
// `IMPLEMENTATION_PLAN_HEADING` — this module never touches a body string.
// `buildGatePlan` resolves no `LabelKey` either — the vocabulary rides along
// on the caller's own `LabelWriteRequest` for `main/writes/command.ts` to
// resolve, the same idiom `shared/claim/classify.ts`'s own `buildClaimRequest`
// follows.
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
  /** Computed by `main/actions/gate.ts` from the item's own body — this
   *  module never parses one, staying label/assignee-only like every other
   *  pure classifier under `shared/`. */
  readonly noPlanBlock: boolean
}

/**
 * `item: null` is the composition root's own "the number does not exist or
 * its alias errored" case, passed straight through as `not-found` — never a
 * thrown error, the same rule `shared/claim/classify.ts`'s own
 * `classifyPreflight` follows. Resolves `planReview` through the vocabulary,
 * never a literal name: an unresolved (module-disabled) key reads as
 * `not-at-plan-review` with the observed labels, since "this repository has
 * no plan gate at all" and "this item isn't at it" both refuse the same way.
 * `assignedElsewhere` is advisory only, never a refusal — the claim is the
 * authorization here (`docs/COORDINATION.md`'s ownership table), the one
 * place this diverges from `shared/claim/classify.ts`'s own ownership check.
 */
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

/**
 * The two plans (plan's own **Data & contracts** table), key-level only —
 * `main/actions/gate.ts` supplies `repoId`/`repo`/`kind`/`number`/
 * `vocabulary`. Both plans set `expect.present` to `['planReview']` — the
 * "don't answer an item that already moved" guard, the same shape
 * `shared/claim/classify.ts` pins `expect.absent: ['marker']` with — and
 * `expect.assignees: { kind: 'any' }` is deliberate: an item assigned to
 * someone else is answerable, never refused on that basis alone.
 */
export function buildGatePlan(decision: GateDecision): GatePlan {
  const add: LabelKey = decision === 'approve' ? 'planApproved' : 'planChangesRequested'
  return {
    add: [add],
    remove: ['planReview'],
    expect: { present: ['planReview'], absent: ['planApproved', 'planChangesRequested'], assignees: { kind: 'any' } },
  }
}
