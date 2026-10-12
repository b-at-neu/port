// The claim dialog's state machine (#93, #319) — a `useSyncExternalStore`
// store, with `claim/dialog.tsx` (a shadcn `Dialog`) as its one renderer.
// Every entry comes from `openClaimDialogFor` (Backlog's own Work on) —
// there is no repo/number picker any more. Every write goes through
// `data/invoke.ts`'s `invoke`, never `window.port` directly.
import { invoke } from '@/renderer/data/invoke'
import type { RepoId } from '@/utils/repos'
import type { ClaimPreflight, ClaimVerdict, PlanGateChoice } from '@/types/claim'
import type { WriteOutcome } from '@/types/writes'

type ClaimState =
  | { readonly step: 'closed' }
  | { readonly step: 'loading'; readonly repoId: RepoId; readonly repo: string; readonly number: number }
  | {
      readonly step: 'reviewing'
      readonly repoId: RepoId
      readonly repo: string
      readonly preflight: ClaimPreflight
      readonly verdict: ClaimVerdict
      readonly planGate: PlanGateChoice
    }
  | { readonly step: 'refused'; readonly repo: string; readonly number: number; readonly verdict: ClaimVerdict; readonly url: string | null }
  | { readonly step: 'preflight-failed'; readonly repoId: RepoId; readonly repo: string; readonly number: number; readonly message: string }
  | { readonly step: 'applying'; readonly number: number }
  | { readonly step: 'moved'; readonly repoId: RepoId; readonly repo: string; readonly number: number; readonly current: readonly string[]; readonly readAt: string }
  | { readonly step: 'refused-at-apply'; readonly repo: string; readonly number: number; readonly verdict: ClaimVerdict }
  | { readonly step: 'write-result'; readonly repoId: RepoId; readonly repo: string; readonly number: number; readonly outcome: WriteOutcome }

let state: ClaimState = { step: 'closed' }
const listeners = new Set<() => void>()
// Set only by `openClaimDialogFor`; fires once on an `applied`/`no-op` write, cleared whenever the dialog closes or reopens.
let onClaimed: (() => void) | null = null

function notify(): void {
  for (const listener of listeners) listener()
}

/** `useSyncExternalStore`'s own subscribe half. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function setState(next: ClaimState): void {
  state = next
  notify()
}

/** Reads `state` through an indirection `await`-narrowing can't see through
 *  — a `let` read directly after an `await` still carries the narrowing
 *  from a guard earlier in the same function, even though `setState` (a
 *  separate function) may have reassigned it in between. Every staleness
 *  check below (`did the dialog move on to something else while this
 *  request was in flight?`) needs the *current* value, not the one TS
 *  narrowed against before the `await`. */
export function getState(): ClaimState {
  return state
}

export function closeClaimDialog(): void {
  onClaimed = null
  setState({ step: 'closed' })
}

// The preflight fetch and its classification — `openClaimDialogFor`'s own read, and `retryPreflight`'s re-read of the same request.
async function runPreflight(repoId: RepoId, repo: string, number: number, planGate: PlanGateChoice): Promise<void> {
  setState({ step: 'loading', repoId, repo, number })
  try {
    const response = await invoke('claim:preflight', { repoId, number })
    if (getState().step !== 'loading') return
    if (response.kind === 'failed') {
      setState({ step: 'preflight-failed', repoId, repo, number, message: response.message })
      return
    }
    if (response.kind === 'unresolved') {
      setState({ step: 'refused', repo, number, verdict: { kind: 'not-found' }, url: null })
      return
    }
    if (response.verdict.kind !== 'claimable') {
      setState({ step: 'refused', repo, number, verdict: response.verdict, url: response.preflight.url })
      return
    }
    setState({ step: 'reviewing', repoId, repo, preflight: response.preflight, verdict: response.verdict, planGate })
  } catch (error) {
    console.error('Failed to reach the main process while reading a claim preflight', error)
    setState({ step: 'preflight-failed', repoId, repo, number, message: 'Failed to reach the main process.' })
  }
}

export function setPlanGate(planGate: PlanGateChoice): void {
  if (state.step !== 'reviewing') return
  setState({ ...state, planGate })
}

interface OpenClaimDialogForParams {
  readonly repoId: RepoId
  readonly repo: string
  readonly number: number
  readonly planGate: PlanGateChoice
  /** Fires once, on an `applied` or `no-op` write. */
  readonly onClaimed: () => void
}

// Enters the dialog directly at `loading`, skipping the repo/number picker — the caller already knows both.
export function openClaimDialogFor(params: OpenClaimDialogForParams): void {
  onClaimed = params.onClaimed
  void runPreflight(params.repoId, params.repo, params.number, params.planGate)
}

export function confirmClaim(): void {
  if (state.step !== 'reviewing') return
  const { repoId, repo, preflight, planGate } = state
  void (async () => {
    setState({ step: 'applying', number: preflight.number })
    try {
      const response = await invoke('claim:apply', { repoId, number: preflight.number, planGate, confirmedAssignees: preflight.assignees })
      if (getState().step !== 'applying') return
      if (response.kind === 'moved') {
        setState({ step: 'moved', repoId, repo, number: preflight.number, current: response.current, readAt: response.readAt })
        return
      }
      if (response.kind === 'refused') {
        setState({ step: 'refused-at-apply', repo, number: preflight.number, verdict: response.verdict })
        return
      }
      if (response.kind === 'preflight-failed') {
        setState({ step: 'preflight-failed', repoId, repo, number: preflight.number, message: response.message })
        return
      }
      setState({ step: 'write-result', repoId, repo, number: preflight.number, outcome: response.outcome })
      if (response.outcome.kind === 'applied' || response.outcome.kind === 'no-op') {
        void invoke('board:refresh', { repoId, source: 'github' })
        onClaimed?.()
      }
    } catch (error) {
      console.error('Failed to reach the main process while applying a claim', error)
      setState({ step: 'preflight-failed', repoId, repo, number: preflight.number, message: 'Failed to reach the main process.' })
    }
  })()
}

/** Re-runs the preflight in place, for both result shapes the plan groups
 *  under the same retry affordance: `moved` (the IPC-level race) and a
 *  `write-result` carrying `precondition-failed` (the write-level race).
 *  `'review'` matches what retry did today through the old picker. */
export function retryPreflight(): void {
  if (state.step === 'moved') {
    const { repoId, repo, number } = state
    void runPreflight(repoId, repo, number, 'review')
    return
  }
  if (state.step === 'write-result' && state.outcome.kind === 'precondition-failed') {
    const { repoId, repo, number } = state
    void runPreflight(repoId, repo, number, 'review')
  }
}
