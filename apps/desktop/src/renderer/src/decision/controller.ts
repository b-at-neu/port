// The decision dialog's state machine and event wiring — the claim dialog's
// own idiom, a native `<dialog>` owning its own `data-action="decide-*"`.
import { reviseNoteProblem } from '../../../shared/actions/decide'
import type { ItemDecisionResult, OperatorDecision, ReviseContext, UnblockContext, UnblockRoute } from '../../../shared/actions/types'
import type { LabelKey } from '../../../shared/labels/vocabulary'
import type { RepoId } from '../../../shared/repos'
import type { createQueryClient } from '../data/query'
import { buildDecisionDialog, renderDecisionDialog } from './view'

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

let state: DecisionState = { step: 'closed' }
let dialog: HTMLDialogElement | null = null

function draw(): void {
  if (dialog) renderDecisionDialog(dialog, state)
}

function setState(next: DecisionState): void {
  state = next
  draw()
}

function getState(): DecisionState {
  return state
}

/** The typed entry point (#319) — opens the dialog directly from an
 *  already-known repoId/number/decision/context, no DOM dataset round trip.
 *  The Board's `nextActionFor` 'decision' choice calls this directly; the
 *  legacy Backlog's own dataset-based click delegation below still goes
 *  through it too, so the two surfaces can never drift on what "open the
 *  decision dialog" means. */
export function openDecision(params: {
  readonly repoId: RepoId
  readonly number: number
  readonly decision: OperatorDecision
  readonly expectedStage: LabelKey | null
  readonly context: UnblockContext | ReviseContext
}): void {
  const { repoId, number, decision, expectedStage, context } = params
  if (decision === 'unblock') {
    setState({ step: 'confirm-unblock', repoId, number, expectedStage, context: context as UnblockContext })
  } else {
    setState({ step: 'confirm-revise', repoId, number, expectedStage, context: context as ReviseContext, text: '' })
  }
}

/** The legacy Backlog row's own click entry point — parses the dataset,
 *  then delegates to `openDecision`. Stays until #320 migrates Backlog's own
 *  DOM. */
export function openDecisionDialog(target: HTMLElement): void {
  const decision = target.dataset.action?.slice('decide-'.length) as OperatorDecision | undefined
  const { repoId, number, stage, context } = target.dataset
  if (!decision || !repoId || !number || context === undefined) return

  const expectedStage = (stage || null) as LabelKey | null
  openDecision({
    repoId: repoId as RepoId,
    number: Number(number),
    decision,
    expectedStage,
    context: JSON.parse(context) as UnblockContext | ReviseContext,
  })
}

async function runDecision(params: {
  readonly repoId: RepoId
  readonly number: number
  readonly expectedStage: LabelKey | null
  readonly decision: OperatorDecision
  readonly route: UnblockRoute | null
  readonly note: string | null
  readonly skipComment: boolean
}): Promise<void> {
  const { repoId, number, expectedStage, decision, route, note, skipComment } = params
  setState({ step: 'applying', repoId, number, decision })
  try {
    const response = await window.port.itemDecide({ repoId, number, decision, expectedStage, route, note, skipComment })
    if (getState().step !== 'applying') return
    setState({ step: 'result', repoId, number, decision, route, response, expectedStage, note })
    if (response.ok && response.labels.kind === 'applied') void window.port.boardRefresh({ repoId, source: 'github' })
  } catch (error) {
    console.error('Failed to reach the main process while applying a decision', error)
    setState({ step: 'result', repoId, number, decision, route, response: { ok: false, reason: 'repo-unavailable' }, expectedStage, note })
  }
}

function submitUnblock(route: UnblockRoute): void {
  if (state.step !== 'confirm-unblock') return
  void runDecision({ repoId: state.repoId, number: state.number, expectedStage: state.expectedStage, decision: 'unblock', route, note: null, skipComment: false })
}

function setReviseText(text: string): void {
  if (state.step !== 'confirm-revise') return
  setState({ ...state, text })
}

function submitRevise(): void {
  if (state.step !== 'confirm-revise') return
  if (reviseNoteProblem(state.text, state.context.headRefOid) !== null) return
  void runDecision({ repoId: state.repoId, number: state.number, expectedStage: state.expectedStage, decision: 'revise', route: null, note: state.text, skipComment: false })
}

/** The one retry affordance that suppresses the comment — a landed comment
 *  followed by an aborted label swap retries the swap alone. */
function retryLabelOnly(): void {
  if (state.step !== 'result') return
  void runDecision({ repoId: state.repoId, number: state.number, expectedStage: state.expectedStage, decision: state.decision, route: state.route, note: state.note, skipComment: true })
}

function closeDecisionDialog(): void {
  setState({ step: 'closed' })
}

function setField(target: HTMLElement): void {
  if (state.step === 'confirm-revise' && target.dataset.field === 'note' && target instanceof HTMLTextAreaElement) {
    setReviseText(target.value)
  }
}

/** Appended once to `#app`, outside the board's own signature-guarded
 *  rebuild. */
export function initDecision(container: HTMLElement, queryClient: ReturnType<typeof createQueryClient>): void {
  // Unused today — kept in the signature for a future live-board caller.
  void queryClient
  dialog = buildDecisionDialog()
  container.appendChild(dialog)
  draw()

  dialog.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const action = target.dataset.action
    if (action === 'decision-cancel') closeDecisionDialog()
    else if (action === 'decision-unblock-revision') submitUnblock('revision')
    else if (action === 'decision-unblock-review') submitUnblock('review')
    else if (action === 'decision-revise-submit') submitRevise()
    else if (action === 'decision-retry-label') retryLabelOnly()
  })

  dialog.addEventListener('input', (event) => {
    if (event.target instanceof HTMLElement) setField(event.target)
  })

  dialog.addEventListener('cancel', () => closeDecisionDialog())
}
