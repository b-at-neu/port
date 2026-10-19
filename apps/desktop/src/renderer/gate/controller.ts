// The plan gate dialog's state machine (#92, #319, #331) — a
// `useSyncExternalStore` store, with `gate/dialog.tsx` (a shadcn `Dialog`,
// its steps split into `gate/dialog-steps.tsx`) as its one renderer. Every
// write goes through `data/invoke.ts`'s `invoke`, never `window.port`
// directly. `openReviewDialog` (a row's own **Review plan** button) is the
// only entry point — the header's former repo-picker-then-claim-step is
// gone along with the claim itself.
import { invoke } from '@/renderer/data/invoke'
import type { RepoId } from '@/utils/repos'
import type { GateDecision, GatePreflight, GateState } from '@/types/gate'

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

/** Re-fetches in place — the retry affordance both a `precondition-failed`
 *  label outcome and a `refused` verdict offer ("Show me the current
 *  state"). */
export function retryPreflight(): void {
  const target = state.step === 'result' ? { repoId: state.repoId, number: state.preflight.number } : state.step === 'refused' ? { repoId: state.repoId, number: state.number } : null
  if (target === null) return
  setState({ step: 'loading', repoId: target.repoId, number: target.number })
  void loadPreflight(target.repoId, target.number)
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

async function runAnswer(repoId: RepoId, preflight: GatePreflight, decision: GateDecision, feedback: string | null, skipComment: boolean): Promise<void> {
  setState({ step: 'answering', repoId, number: preflight.number })
  try {
    const response = await invoke('gate:answer', { repoId, number: preflight.number, decision, feedback, skipComment })
    if (getState().step !== 'answering') return
    setState({ step: 'result', repoId, preflight, decision, feedback, response })
    if (response.kind === 'answered' && response.labels.kind === 'applied') {
      void invoke('board:refresh', { repoId, source: 'github' })
    }
  } catch (error) {
    console.error('Failed to reach the main process while answering the plan gate', error)
    setState({ step: 'preflight-failed', repoId, number: preflight.number, message: 'Failed to reach the main process.' })
  }
}

export function submitApprove(): void {
  if (state.step !== 'reviewing') return
  void runAnswer(state.repoId, state.preflight, 'approve', null, false)
}

export function submitFeedback(): void {
  if (state.step !== 'feedback' || state.text.trim() === '') return
  void runAnswer(state.repoId, state.preflight, 'request-changes', state.text, false)
}

/** The one retry affordance that suppresses the comment — a landed comment
 *  followed by an aborted label swap retries the swap alone. */
export function retryLabelOnly(): void {
  if (state.step !== 'result') return
  void runAnswer(state.repoId, state.preflight, state.decision, null, true)
}

export function tryCommentAgain(): void {
  if (state.step !== 'result') return
  void runAnswer(state.repoId, state.preflight, state.decision, state.feedback, false)
}

export function closeGateDialog(): void {
  setState({ step: 'closed' })
}
