// Every pipeline write with its state writer and store-label reader bound, built once at the composition root.
import { applyItemAction } from '@/main/pipeline/operator/apply'
import { applyItemDecision } from '@/main/pipeline/operator/decide'
import { escalateToHuman } from '@/main/pipeline/operator/escalate'
import { autoApprovePlan, gateAnswer, gatePreflight } from '@/main/pipeline/operator/gate'
import { applyObservation } from '@/main/pipeline/operator/observe'
import { recoverPausedTrigger } from '@/main/pipeline/operator/resume'
import { applyStageClaim, applyStageTransition, type StageWriteDeps } from '@/main/pipeline/operator/stage'
import { fetchClaimPreflight, fetchItemsByNumber } from '@/main/github/tracker/items'
import { fetchGatePreflight } from '@/main/github/tracker/gate'
import { listRepositories } from '@/main/repos'
import { postComment, postIssueBody } from '@/main/github/writes/apply'
import { rerunChecks } from '@/main/pipeline/operator/rerun'
import type { ApplyItemActionParams, ApplyItemDecisionParams, ApplyObservationParams, AutoApprovePlanParams, EscalateToHumanParams, GateAnswerParams, GatePreflightParams, RerunChecksParams } from '@/types/actions'
import type { ClaimDeps } from '@/types/claim'
import type { OwnershipParams, OwnershipRead, StageLabelWrites } from '@/types/dispatch'
import type { GateDeps } from '@/types/gate'
import type { StateLabelsReader } from '@/types/pipeline-state'
import type { FetchItemsByNumberParams } from '@/types/github'
import type { PostCommentParams, WriteEvent, WriteState } from '@/types/writes'
import type { GitHubReadContext, GitHubWriteContext } from '@/main/github/context'

export function bindOperator(platform: GitHubWriteContext & GitHubReadContext, state: { readonly writeState: WriteState; readonly writeEvent: WriteEvent; readonly ticketOf: StageWriteDeps['ticketOf']; readonly stateLabels: StateLabelsReader }, readOwnership: (params: OwnershipParams) => Promise<OwnershipRead>) {
  const { writeState, writeEvent, ticketOf, stateLabels } = state
  const comment = (params: PostCommentParams) => postComment(platform, params)
  const issueBody = (params: PostCommentParams) => postIssueBody(platform, params)
  const fetchItems = (params: FetchItemsByNumberParams) => fetchItemsByNumber(platform, params)
  const gateDeps: GateDeps = { listRepositories, fetchGatePreflight: (params) => fetchGatePreflight(platform, params), readOwnership, writeState, stateLabels, postComment: comment, now: () => new Date() }
  const stageDeps: StageWriteDeps = { writeEvent, ticketOf, postIssueBody: issueBody, fetchItemsByNumber: fetchItems }
  const stageLabels: StageLabelWrites = { claim: (params) => applyStageClaim(params, stageDeps), transition: (params) => applyStageTransition(params, stageDeps) }
  const claimDeps: ClaimDeps = { listRepositories, fetchClaimPreflight: (params) => fetchClaimPreflight(platform, params), writeState, stateLabels }
  return {
    applyItemAction: (params: ApplyItemActionParams) => applyItemAction(params, { writeState, recoverPausedTrigger }),
    applyItemDecision: (params: ApplyItemDecisionParams) => applyItemDecision(params, { writeState, stateLabels, postComment: comment, fetchItemsByNumber: fetchItems }),
    gatePreflight: (params: GatePreflightParams) => gatePreflight(params, gateDeps),
    gateAnswer: (params: GateAnswerParams) => gateAnswer(params, gateDeps),
    autoApprovePlan: (params: AutoApprovePlanParams) => autoApprovePlan(params, { writeState }),
    escalateToHuman: (params: EscalateToHumanParams) => escalateToHuman(params, { writeState, postComment: comment }),
    applyObservation: (params: ApplyObservationParams) => applyObservation(params, { writeState, postComment: comment, fetchGatePreflight: gateDeps.fetchGatePreflight }),
    rerunChecks: (params: RerunChecksParams) => rerunChecks(platform, params),
    stageLabels,
    claimDeps,
  }
}
