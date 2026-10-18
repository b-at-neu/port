// The decision dialog's state machine — a `useSyncExternalStore` store, the
// same shape `gate/controller.ts` already establishes.
import { invoke } from '@/renderer/data/invoke'
import { pickList, picksProblem, reviseNoteProblem } from '@/utils/actions/decide'
import type { OperatorDecision, RebasePick, ReviseContext, UnblockContext, UnblockRoute } from '@/types/actions'
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'
import type { DecisionState } from '@/types/decision'

let state: DecisionState = { step: 'closed' }
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getState(): DecisionState {
  return state
}

function setState(next: DecisionState): void {
  state = next
  notify()
}

export function openDecision(params: {
  readonly repoId: RepoId
  readonly number: number
  readonly decision: OperatorDecision
  readonly expectedStage: LabelKey | null
  readonly context: UnblockContext | ReviseContext
}): void {
  const { repoId, number, decision, expectedStage, context } = params
  if (decision === 'unblock') {
    const unblock = context as UnblockContext
    const picks = Object.fromEntries(unblock.decisions.flatMap((d) => (d.recommended === null ? [] : [[d.id, d.recommended]])))
    setState({ step: 'confirm-unblock', repoId, number, expectedStage, context: unblock, picks })
  } else {
    setState({ step: 'confirm-revise', repoId, number, expectedStage, context: context as ReviseContext, text: '' })
  }
}

async function runDecision(params: {
  readonly repoId: RepoId
  readonly number: number
  readonly expectedStage: LabelKey | null
  readonly decision: OperatorDecision
  readonly route: UnblockRoute | null
  readonly note: string | null
  readonly skipComment: boolean
  readonly picks: readonly RebasePick[] | null
}): Promise<void> {
  const { repoId, number, expectedStage, decision, route, note, skipComment, picks } = params
  setState({ step: 'applying', repoId, number, decision })
  try {
    const response = await invoke('item:decide', { repoId, number, decision, expectedStage, route, note, skipComment, picks })
    if (getState().step !== 'applying') return
    setState({ step: 'result', repoId, number, decision, route, response, expectedStage, note, picks })
    if (response.ok && response.labels.kind === 'applied') void invoke('board:refresh', { repoId, source: 'github' })
  } catch (error) {
    console.error('Failed to reach the main process while applying a decision', error)
    setState({ step: 'result', repoId, number, decision, route, response: { ok: false, reason: 'repo-unavailable' }, expectedStage, note, picks })
  }
}

export function setPick(id: string, letter: string): void {
  if (state.step !== 'confirm-unblock') return
  setState({ ...state, picks: { ...state.picks, [id]: letter } })
}

export function submitUnblock(route: UnblockRoute): void {
  if (state.step !== 'confirm-unblock') return
  const { decisions } = state.context
  const chosen = state.picks
  const picks = decisions.length === 0 ? null : pickList(decisions, chosen)
  if (picks !== null && picksProblem(decisions, picks) !== null) return
  void runDecision({ repoId: state.repoId, number: state.number, expectedStage: state.expectedStage, decision: 'unblock', route, note: null, skipComment: false, picks })
}

export function setReviseText(text: string): void {
  if (state.step !== 'confirm-revise') return
  setState({ ...state, text })
}

export function submitRevise(): void {
  if (state.step !== 'confirm-revise') return
  if (reviseNoteProblem(state.text, state.context.headRefOid) !== null) return
  void runDecision({ repoId: state.repoId, number: state.number, expectedStage: state.expectedStage, decision: 'revise', route: null, note: state.text, skipComment: false, picks: null })
}

/** Suppresses the comment — a landed comment followed by an aborted label swap retries the swap alone. */
export function retryLabelOnly(): void {
  if (state.step !== 'result') return
  void runDecision({ repoId: state.repoId, number: state.number, expectedStage: state.expectedStage, decision: state.decision, route: state.route, note: state.note, skipComment: true, picks: state.picks })
}

export function closeDecisionDialog(): void {
  setState({ step: 'closed' })
}
