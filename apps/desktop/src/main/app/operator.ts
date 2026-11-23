// Every pipeline write with its state writer and store-label reader bound, built once at the composition root.
import { applyItemAction } from '@/main/operator/apply'
import { applyItemDecision } from '@/main/operator/decide'
import { escalateToHuman } from '@/main/operator/escalate'
import { autoApprovePlan, gateAnswer, gatePreflight } from '@/main/operator/gate'
import { applyObservation } from '@/main/operator/observe'
import { recoverPausedTrigger } from '@/main/operator/resume'
import { applyStageClaim, applyStageTransition } from '@/main/operator/stage'
import { readOwnership } from '@/main/repos/ownership'
import { fetchClaimPreflight, fetchItemsByNumber } from '@/main/github/adapter'
import { fetchGatePreflight } from '@/main/github/gate'
import { listRepositories } from '@/main/repos'
import { postComment, postIssueBody } from '@/main/writes/apply'
import { rerunChecks } from '@/main/operator/rerun'
import type { ApplyItemActionParams, ApplyItemDecisionParams, ApplyObservationParams, AutoApprovePlanParams, EscalateToHumanParams, GateAnswerParams, GatePreflightParams, RerunChecksParams } from '@/types/actions'
import type { ClaimDeps } from '@/types/claim'
import type { StageLabelWrites } from '@/types/dispatch'
import type { GateDeps } from '@/types/gate'
import type { StateLabelsReader } from '@/types/pipeline-state'
import type { WriteState } from '@/types/writes'

export function bindOperator(state: { readonly writeState: WriteState; readonly stateLabels: StateLabelsReader }) {
  const { writeState, stateLabels } = state
  const gateDeps: GateDeps = { listRepositories, fetchGatePreflight, readOwnership, writeState, stateLabels, postComment, now: () => new Date() }
  const stageDeps = { writeState, postIssueBody, stateLabels, fetchItemsByNumber }
  const stageLabels: StageLabelWrites = { claim: (params) => applyStageClaim(params, stageDeps), transition: (params) => applyStageTransition(params, stageDeps) }
  const claimDeps: ClaimDeps = { listRepositories, fetchClaimPreflight, writeState, stateLabels }
  return {
    applyItemAction: (params: ApplyItemActionParams) => applyItemAction(params, { writeState, recoverPausedTrigger }),
    applyItemDecision: (params: ApplyItemDecisionParams) => applyItemDecision(params, { writeState, stateLabels, postComment, fetchItemsByNumber }),
    gatePreflight: (params: GatePreflightParams) => gatePreflight(params, gateDeps),
    gateAnswer: (params: GateAnswerParams) => gateAnswer(params, gateDeps),
    autoApprovePlan: (params: AutoApprovePlanParams) => autoApprovePlan(params, { writeState }),
    escalateToHuman: (params: EscalateToHumanParams) => escalateToHuman(params, { writeState, postComment }),
    applyObservation: (params: ApplyObservationParams) => applyObservation(params, { writeState, postComment }),
    rerunChecks: (params: RerunChecksParams) => rerunChecks(params),
    stageLabels,
    claimDeps,
  }
}
