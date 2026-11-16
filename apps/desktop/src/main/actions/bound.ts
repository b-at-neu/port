// Every action with its state writer and store-label reader bound, built once at the composition root.
import { applyItemAction } from '@/main/actions/apply'
import { applyItemDecision } from '@/main/actions/decide'
import { escalateToHuman } from '@/main/actions/escalate'
import { autoApprovePlan, gateAnswer, gatePreflight } from '@/main/actions/gate'
import { applyObservation } from '@/main/actions/observe'
import { recoverPausedTrigger } from '@/main/actions/resume'
import { applyStageClaim, applyStageTransition } from '@/main/actions/stage'
import { readOwnership } from '@/main/dispatch/ownership'
import { fetchClaimPreflight, fetchItemsByNumber } from '@/main/github/adapter'
import { fetchGatePreflight } from '@/main/github/gate'
import { listRepositories } from '@/main/registry'
import { postComment, postIssueBody } from '@/main/writes/apply'
import type { ApplyItemActionParams, ApplyItemDecisionParams, ApplyObservationParams, AutoApprovePlanParams, EscalateToHumanParams, GateAnswerParams, GatePreflightParams } from '@/types/actions'
import type { ClaimDeps } from '@/types/claim'
import type { StageLabelWrites } from '@/types/dispatch'
import type { GateDeps } from '@/types/gate'
import type { StateLabelsReader } from '@/types/pipeline-state'
import type { WriteState } from '@/types/writes'

export function bindActions(state: { readonly writeState: WriteState; readonly stateLabels: StateLabelsReader }) {
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
    stageLabels,
    claimDeps,
  }
}
