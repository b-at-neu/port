// The decision dialog's state machine — a `useSyncExternalStore` store, the
// same shape `gate/controller.ts` already establishes.
import { invoke } from '@/renderer/data/invoke'
import { runInBackground } from '@/renderer/lib/background-action'
import { decisionResultCopy } from '@/renderer/decision/copy'
import { pickList, picksProblem, reviseNoteProblem } from '@/utils/actions/decide'
import type { ItemDecisionResult, OperatorDecision, RebasePick, ReviseContext, UnblockContext, UnblockRoute } from '@/types/actions'
import type { ActionToast } from '@/types/toast'
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

interface DecisionRun {
  readonly repoId: RepoId
  readonly number: number
  readonly expectedStage: LabelKey | null
  readonly decision: OperatorDecision
  readonly route: UnblockRoute | null
  readonly note: string | null
  readonly skipComment: boolean
  readonly picks: readonly RebasePick[] | null
}

function pendingLine(decision: OperatorDecision, route: UnblockRoute | null, number: number): string {
  if (decision === 'revise') return `Sending PR #${String(number)} back…`
  return `Unblocking ${route === 'implementation' ? '#' : 'PR #'}${String(number)}…`
}

function toastFor(run: DecisionRun, response: ItemDecisionResult): ActionToast {
  const { number, decision, route, picks } = run
  const copy = decisionResultCopy({ number, decision, route, picks, response })
  const swapLabelsOnly = { label: 'Swap labels only', onClick: () => void runDecision({ ...run, skipComment: true }) }
  return { tone: copy.tone, title: copy.line, description: copy.note, action: copy.offerLabelOnly ? swapLabelsOnly : null, cancel: null }
}

async function runDecision(run: DecisionRun): Promise<void> {
  const { repoId, number, expectedStage, decision, route, note, skipComment, picks } = run
  const response = await runInBackground({
    id: `decision:${repoId}:${String(number)}`,
    pending: pendingLine(decision, route, number),
    run: () => invoke('item:decide', { repoId, number, decision, expectedStage, route, note, skipComment, picks }),
    toToast: (result) => toastFor(run, result),
    unreachable: toastFor(run, { ok: false, reason: 'repo-unavailable' }),
  })
  if (response !== 'unreachable' && response.ok && response.labels.kind === 'applied') void invoke('board:refresh', { repoId, source: 'github' })
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
  const { repoId, number, expectedStage } = state
  closeDecisionDialog()
  void runDecision({ repoId, number, expectedStage, decision: 'unblock', route, note: null, skipComment: false, picks })
}

export function setReviseText(text: string): void {
  if (state.step !== 'confirm-revise') return
  setState({ ...state, text })
}

export function submitRevise(): void {
  if (state.step !== 'confirm-revise') return
  if (reviseNoteProblem(state.text, state.context.headRefOid) !== null) return
  const { repoId, number, expectedStage, text } = state
  closeDecisionDialog()
  void runDecision({ repoId, number, expectedStage, decision: 'revise', route: null, note: text, skipComment: false, picks: null })
}

export function closeDecisionDialog(): void {
  setState({ step: 'closed' })
}
