import type { ItemDecisionResult, OperatorDecision, ReviseContext, UnblockContext, UnblockRoute } from '@/types/actions'
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'

export type DecisionState =
  | { readonly step: 'closed' }
  | { readonly step: 'confirm-unblock'; readonly repoId: RepoId; readonly number: number; readonly expectedStage: LabelKey | null; readonly context: UnblockContext }
  | { readonly step: 'confirm-revise'; readonly repoId: RepoId; readonly number: number; readonly expectedStage: LabelKey | null; readonly context: ReviseContext; readonly text: string }
  | { readonly step: 'applying'; readonly repoId: RepoId; readonly number: number; readonly decision: OperatorDecision }
  | {
      readonly step: 'result'
      readonly repoId: RepoId
      readonly number: number
      readonly decision: OperatorDecision
      readonly route: UnblockRoute | null
      readonly response: ItemDecisionResult
      readonly expectedStage: LabelKey | null
      readonly note: string | null
    }
