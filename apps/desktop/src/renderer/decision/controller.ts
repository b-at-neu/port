import { createStore, useStore } from '@/renderer/lib/store'
import type { GrantContext, OperatorDecision, ReviseContext, UnblockContext } from '@/types/actions'
import type { DecisionTarget } from '@/types/decision'
import type { TicketView } from '@/utils/pipeline/stages'
import type { RepoId } from '@/utils/repos'

const decisionTarget = createStore<DecisionTarget | null>(null)

export function openDecision(params: {
  readonly repoId: RepoId
  readonly number: number
  readonly decision: OperatorDecision
  readonly expected: TicketView | null
  readonly context: UnblockContext | ReviseContext | GrantContext
}): void {
  const { repoId, number, decision, expected, context } = params
  const base = { repoId, number, expected }
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
