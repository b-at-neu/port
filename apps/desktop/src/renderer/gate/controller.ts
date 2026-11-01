// The plan gate dialog's state machine (#92, #319, #331) — a
// `useSyncExternalStore` store, with `gate/dialog.tsx` (a shadcn `Dialog`,
// its steps split into `gate/dialog-steps.tsx`) as its one renderer. Every
// write goes through `data/invoke.ts`'s `invoke`, never `window.port`
// directly. `openReviewDialog` (a row's own **Review plan** button) is the
// only entry point — the header's former repo-picker-then-claim-step is
// gone along with the claim itself.
import { invoke } from '@/renderer/data/invoke'
import { runInBackground } from '@/renderer/lib/background-action'
import { resultCopy } from '@/renderer/gate/copy'
import type { RepoId } from '@/utils/repos'
import type { GateAnswerResponse, GateDecision, GatePreflight, GateState } from '@/types/gate'
import type { ActionToast } from '@/types/toast'
import type { OwnershipSummary } from '@/types/writes'

let state: GateState = { step: 'closed' }
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** `useSyncExternalStore`'s own subscribe half. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function setState(next: GateState): void {
  state = next
  notify()
}

/** Reads `state` through a call, because TypeScript keeps a pre-`await` narrowing on a `let` read directly after the `await`. */
export function getState(): GateState {
  return state
}

/** A `plan review` row's own **Review plan** button — straight to the
 *  preflight for that specific issue, no repository picker. */
export function openReviewDialog(repoId: RepoId, number: number): void {
  setState({ step: 'loading', repoId, number })
  void loadPreflight(repoId, number)
}

async function loadPreflight(repoId: RepoId, number: number): Promise<void> {
  try {
    const response = await invoke('gate:preflight', { repoId, number })
    if (getState().step !== 'loading') return
    if (response.kind === 'failed') {
      setState({ step: 'preflight-failed', repoId, number, message: response.message })
      return
    }
    if (response.kind === 'unresolved') {
      setState({ step: 'refused', repoId, number, verdict: { kind: 'not-found' } })
      return
    }
    if (response.verdict.kind !== 'answerable') {
      setState({ step: 'refused', repoId, number, verdict: response.verdict })
      return
    }
    setState({ step: 'reviewing', repoId, preflight: response.preflight, verdict: response.verdict, ownership: response.ownership })
  } catch (error) {
    console.error('Failed to reach the main process while reading the plan gate preflight', error)
    setState({ step: 'preflight-failed', repoId, number, message: 'Failed to reach the main process.' })
  }
}

/** Re-fetches in place — the retry affordance a `refused` verdict offers ("Show me the current state"). */
export function retryPreflight(): void {
  if (state.step !== 'refused') return
  const { repoId, number } = state
  setState({ step: 'loading', repoId, number })
  void loadPreflight(repoId, number)
}

export function openFeedback(): void {
  if (state.step !== 'reviewing') return
  setState({ step: 'feedback', repoId: state.repoId, preflight: state.preflight, verdict: state.verdict, ownership: state.ownership, text: '' })
}

export function backToReview(): void {
  if (state.step !== 'feedback') return
  setState({ step: 'reviewing', repoId: state.repoId, preflight: state.preflight, verdict: state.verdict, ownership: state.ownership })
}

export function setFeedbackText(text: string): void {
  if (state.step !== 'feedback') return
  setState({ ...state, text })
}

interface GateAnswerRun {
  readonly repoId: RepoId
  readonly preflight: GatePreflight
  readonly ownership: OwnershipSummary
  readonly decision: GateDecision
  readonly feedback: string | null
  readonly skipComment: boolean
}

function toastFor(run: GateAnswerRun, response: GateAnswerResponse): ActionToast {
  const { repoId, preflight, ownership, decision, feedback } = run
  const copy = resultCopy({ number: preflight.number, decision, response, sessionRequired: preflight.sessionRequired, ownership })
  // A landed comment followed by an aborted label swap retries the swap alone, so the retry suppresses the comment.
  const retryLabel = { label: 'Retry the label change', onClick: () => void runAnswer({ ...run, feedback: null, skipComment: true }) }
  const tryAgain = { label: 'Try again', onClick: () => void runAnswer({ ...run, feedback, skipComment: false }) }
  const showState = { label: 'Show current state', onClick: () => openReviewDialog(repoId, preflight.number) }
  const action = copy.actions.includes('retry-label') ? retryLabel : copy.actions.includes('try-again') ? tryAgain : null
  const cancel = copy.actions.includes('show-state') ? showState : null
  return { tone: copy.tone, title: copy.line, description: copy.note === null || copy.note === '' ? null : copy.note, action, cancel }
}

async function runAnswer(run: GateAnswerRun): Promise<void> {
  const { repoId, preflight, decision, feedback, skipComment } = run
  const number = preflight.number
  const response = await runInBackground({
    id: `gate:${repoId}:${String(number)}`,
    pending: decision === 'approve' ? `Approving #${String(number)}…` : `Requesting changes on #${String(number)}…`,
    run: () => invoke('gate:answer', { repoId, number, decision, feedback, skipComment }),
    toToast: (result) => toastFor(run, result),
  })
  if (response !== 'unreachable' && response.kind === 'answered' && response.labels.kind === 'applied') void invoke('board:refresh', { repoId, source: 'github' })
}

export function submitApprove(): void {
  if (state.step !== 'reviewing') return
  const { repoId, preflight, ownership } = state
  closeGateDialog()
  void runAnswer({ repoId, preflight, ownership, decision: 'approve', feedback: null, skipComment: false })
}

export function submitFeedback(): void {
  if (state.step !== 'feedback' || state.text.trim() === '') return
  const { repoId, preflight, ownership, text } = state
  closeGateDialog()
  void runAnswer({ repoId, preflight, ownership, decision: 'request-changes', feedback: text, skipComment: false })
}

export function closeGateDialog(): void {
  setState({ step: 'closed' })
}
