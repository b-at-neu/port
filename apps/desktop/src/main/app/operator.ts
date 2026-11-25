// Every pipeline write bound to the one ctx; today's feature call sites still take this shape.
import { applyItemAction } from '@/main/pipeline/operator/apply'
import { applyItemDecision } from '@/main/pipeline/operator/decide'
import { escalateToHuman } from '@/main/pipeline/operator/escalate'
import { autoApprovePlan, gateAnswer, gatePreflight } from '@/main/pipeline/operator/gate'
import { applyObservation } from '@/main/pipeline/operator/observe'
import { rerunChecks } from '@/main/pipeline/operator/rerun'
import { applyStageClaim, applyStageTransition } from '@/main/pipeline/operator/stage'
import { storedLabels } from '@/main/pipeline/state/labels'
import type { OperatorContext } from '@/main/pipeline/context'
import type { ApplyItemActionParams, ApplyItemDecisionParams, ApplyObservationParams, AutoApprovePlanParams, EscalateToHumanParams, GateAnswerParams, GatePreflightParams, RerunChecksParams } from '@/types/actions'
import type { StageLabelWrites } from '@/types/dispatch'
import type { StateLabelsReader } from '@/types/pipeline-state'

export function bindOperator(ctx: OperatorContext) {
  const stageLabels: StageLabelWrites = { claim: (params) => applyStageClaim(ctx, params), transition: (params) => applyStageTransition(ctx, params) }
  const stateLabels: StateLabelsReader = (repoId, kind, number, vocabulary) => storedLabels(ctx, repoId, kind, number, vocabulary)
  return {
    applyItemAction: (params: ApplyItemActionParams) => applyItemAction(ctx, params),
    applyItemDecision: (params: ApplyItemDecisionParams) => applyItemDecision(ctx, params),
    gatePreflight: (params: GatePreflightParams) => gatePreflight(ctx, params),
    gateAnswer: (params: GateAnswerParams) => gateAnswer(ctx, params),
    autoApprovePlan: (params: AutoApprovePlanParams) => autoApprovePlan(ctx, params),
    escalateToHuman: (params: EscalateToHumanParams) => escalateToHuman(ctx, params),
    applyObservation: (params: ApplyObservationParams) => applyObservation(ctx, params),
    rerunChecks: (params: RerunChecksParams) => rerunChecks(ctx, params),
    stageLabels,
    stateLabels,
  }
}
