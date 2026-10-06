// The plan gate dialog's state machine (#92, #319) — a `useSyncExternalStore`
// store now, with `gate/dialog.tsx` (a shadcn `Dialog`, its steps split into
// `gate/dialog-steps.tsx`) as its one renderer in place of the deleted
// `view.ts`'s native `<dialog>`. Every write goes through `data/invoke.ts`'s
// `invoke`, never `window.port` directly.
import { invoke } from '../data/invoke'
import type { RepoId, RepositoryEntry } from '../../../shared/repos'
import type { GateAnswerResponse, GateDecision, GatePreflight, GateVerdict } from '../../../shared/gate/types'
import type { ClaimRead } from '../../../shared/writes/types'

export interface ReadyRepo {
  readonly id: RepoId
  readonly repo: string
}

type AnswerableVerdict = Extract<GateVerdict, { readonly kind: 'answerable' }>
type RefusalVerdict = Exclude<GateVerdict, { readonly kind: 'answerable' }>

export type GateState =
  | { readonly step: 'closed' }
  | { readonly step: 'claim-picking'; readonly repos: readonly ReadyRepo[]; readonly repoId: RepoId | null }
  | { readonly step: 'claim-loading'; readonly repoId: RepoId }
  | { readonly step: 'claim-view'; readonly repoId: RepoId; readonly claim: ClaimRead }
  | { readonly step: 'claim-acting'; readonly repoId: RepoId }
  | { readonly step: 'claim-failed'; readonly repoId: RepoId; readonly message: string }
  | { readonly step: 'loading'; readonly repoId: RepoId; readonly number: number }
  | { readonly step: 'reviewing'; readonly repoId: RepoId; readonly preflight: GatePreflight; readonly verdict: AnswerableVerdict; readonly claim: ClaimRead }
  | { readonly step: 'feedback'; readonly repoId: RepoId; readonly preflight: GatePreflight; readonly verdict: AnswerableVerdict; readonly claim: ClaimRead; readonly text: string }
  | { readonly step: 'answering'; readonly repoId: RepoId; readonly number: number }
  | { readonly step: 'refused'; readonly repoId: RepoId; readonly number: number; readonly verdict: RefusalVerdict }
  | { readonly step: 'preflight-failed'; readonly repoId: RepoId; readonly number: number; readonly message: string }
  | {
      readonly step: 'result'
      readonly repoId: RepoId
      readonly preflight: GatePreflight
      readonly decision: GateDecision
      readonly feedback: string | null
      readonly response: GateAnswerResponse
    }

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

/** The same indirection `claim/controller.ts`'s own `getState` documents —
 *  a `let` read directly after an `await` still carries the narrowing from a
 *  guard earlier in the same function, even though `setState` may have
 *  reassigned it in between. */
export function getState(): GateState {
  return state
}

function isReady(entry: RepositoryEntry): entry is Extract<RepositoryEntry, { status: 'ready' }> {
  return 'config' in entry
}

async function loadRepos(): Promise<readonly ReadyRepo[]> {
  const result = await invoke('repos:list')
  if (!result.ok) return []
  return result.repositories.filter(isReady).map((entry) => ({ id: entry.id, repo: entry.config.repo }))
}

async function loadClaim(repoId: RepoId): Promise<void> {
  setState({ step: 'claim-loading', repoId })
  try {
    const claim = await invoke('gate:claim:read', { repoId })
    if (getState().step !== 'claim-loading') return
    setState({ step: 'claim-view', repoId, claim })
  } catch (error) {
    console.error('Failed to read the plan-gate claim', error)
    setState({ step: 'claim-failed', repoId, message: 'Failed to reach the main process.' })
  }
}

/** The header's own **Plan gate** entry point — a repository picker when
 *  more than one is ready, then the claim step. */
export function openGateDialog(): void {
  setState({ step: 'claim-picking', repos: [], repoId: null })
  void loadRepos().then((repos) => {
    if (state.step !== 'claim-picking') return
    const only = repos.length === 1 ? repos[0] : undefined
    const repoId = state.repoId ?? only?.id ?? null
    setState({ ...state, repos, repoId })
    if (repoId !== null) void loadClaim(repoId)
  })
}

export function pickRepo(repoId: RepoId): void {
  if (state.step !== 'claim-picking') return
  setState({ ...state, repoId })
  void loadClaim(repoId)
}

export function setClaim(held: boolean): void {
  const repoId = state.step === 'claim-view' ? state.repoId : state.step === 'reviewing' ? state.repoId : null
  if (repoId === null) return
  const from = state
  void (async () => {
    setState({ step: 'claim-acting', repoId })
    try {
      const response = await invoke('gate:claim:set', { repoId, held })
      if (getState().step !== 'claim-acting') return
      if (response.kind === 'failed') {
        const message = response.result.ok ? 'unknown failure' : response.result.message
        setState({ step: 'claim-failed', repoId, message })
        return
      }
      if (from.step === 'reviewing') {
        setState({ step: 'reviewing', repoId, preflight: from.preflight, verdict: from.verdict, claim: response.claim })
      } else {
        setState({ step: 'claim-view', repoId, claim: response.claim })
      }
    } catch (error) {
      console.error('Failed to reach the main process while changing the plan-gate claim', error)
      setState({ step: 'claim-failed', repoId, message: 'Failed to reach the main process.' })
    }
  })()
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
    setState({ step: 'reviewing', repoId, preflight: response.preflight, verdict: response.verdict, claim: response.claim })
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
  setState({ step: 'feedback', repoId: state.repoId, preflight: state.preflight, verdict: state.verdict, claim: state.claim, text: '' })
}

export function backToReview(): void {
  if (state.step !== 'feedback') return
  setState({ step: 'reviewing', repoId: state.repoId, preflight: state.preflight, verdict: state.verdict, claim: state.claim })
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

/** The result step's own **take the plan gate** shortcut — routes to the
 *  claim step for the same repository, never a second dialog. */
export function goToClaimStep(): void {
  if (state.step !== 'result') return
  const { repoId } = state
  setState({ step: 'claim-picking', repos: [], repoId })
  void loadRepos().then((repos) => {
    if (state.step !== 'claim-picking') return
    setState({ ...state, repos })
    void loadClaim(repoId)
  })
}

export function closeGateDialog(): void {
  setState({ step: 'closed' })
}
