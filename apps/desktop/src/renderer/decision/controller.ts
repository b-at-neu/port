import { createStore, useStore } from '@/renderer/lib/store'
import type { GrantContext, OperatorDecision, ReviseContext, UnblockContext } from '@/types/actions'
import type { DecisionTarget } from '@/types/decision'
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'

const decisionTarget = createStore<DecisionTarget | null>(null)

export function openDecision(params: {
  readonly repoId: RepoId
  readonly number: number
  readonly decision: OperatorDecision
  readonly expectedStage: LabelKey | null
  readonly context: UnblockContext | ReviseContext | GrantContext
}): void {
  const { repoId, number, decision, expectedStage, context } = params
  const base = { repoId, number, expectedStage }
  if (decision === 'unblock') decisionTarget.set({ ...base, decision, context: context as UnblockContext })
  else if (decision === 'grant') decisionTarget.set({ ...base, decision, context })
  else decisionTarget.set({ ...base, decision, context: context as ReviseContext })
}

export function closeDecisionDialog(): void {
  decisionTarget.set(null)
}

export function useDecisionTarget(): DecisionTarget | null {
  return useStore(decisionTarget)
}
