// The plan gate dialog's state machine and its own event wiring (#92) — the
// dialog owns its `data-action="gate-*"` handling directly, rather than
// routing through `main.ts`'s delegated board/repositories handler, so the
// entry point there stays exactly two branches (the header button and a
// row's own "Review plan" button).
import type { RepoId, RepositoryEntry } from '../../../shared/repos'
import type { GateAnswerResponse, GateDecision, GatePreflight, GateVerdict } from '../../../shared/gate/types'
import type { ClaimRead } from '../../../shared/writes/types'
import { buildGateDialog, renderGateDialog } from './view'

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
let dialog: HTMLDialogElement | null = null

function draw(): void {
  if (dialog) renderGateDialog(dialog, state)
}

function setState(next: GateState): void {
  state = next
  draw()
}

/** The same indirection `claim/controller.ts`'s own `getState` documents —
 *  a `let` read directly after an `await` still carries the narrowing from a
 *  guard earlier in the same function, even though `setState` may have
 *  reassigned it in between. */
function getState(): GateState {
  return state
}

function isReady(entry: RepositoryEntry): entry is Extract<RepositoryEntry, { status: 'ready' }> {
  return 'config' in entry
}

async function loadRepos(): Promise<readonly ReadyRepo[]> {
  const result = await window.port.reposList()
  if (!result.ok) return []
  return result.repositories.filter(isReady).map((entry) => ({ id: entry.id, repo: entry.config.repo }))
}

async function loadClaim(repoId: RepoId): Promise<void> {
  setState({ step: 'claim-loading', repoId })
  try {
    const claim = await window.port.gateClaimRead({ repoId })
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

function pickRepo(repoId: RepoId): void {
  if (state.step !== 'claim-picking') return
  setState({ ...state, repoId })
  void loadClaim(repoId)
}

async function setClaim(held: boolean): Promise<void> {
  const repoId = state.step === 'claim-view' ? state.repoId : state.step === 'reviewing' ? state.repoId : null
  if (repoId === null) return
  const from = state
  setState({ step: 'claim-acting', repoId })
  try {
    const response = await window.port.gateClaimSet({ repoId, held })
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
}

/** A `plan review` row's own **Review plan** button — straight to the
 *  preflight for that specific issue, no repository picker. */
export function openReviewDialog(repoId: RepoId, number: number): void {
  setState({ step: 'loading', repoId, number })
  void loadPreflight(repoId, number)
}

async function loadPreflight(repoId: RepoId, number: number): Promise<void> {
  try {
    const response = await window.port.gatePreflight({ repoId, number })
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
function retryPreflight(): void {
  const target = state.step === 'result' ? { repoId: state.repoId, number: state.preflight.number } : state.step === 'refused' ? { repoId: state.repoId, number: state.number } : null
  if (target === null) return
  setState({ step: 'loading', repoId: target.repoId, number: target.number })
  void loadPreflight(target.repoId, target.number)
}

function openFeedback(): void {
  if (state.step !== 'reviewing') return
  setState({ step: 'feedback', repoId: state.repoId, preflight: state.preflight, verdict: state.verdict, claim: state.claim, text: '' })
}

function backToReview(): void {
  if (state.step !== 'feedback') return
  setState({ step: 'reviewing', repoId: state.repoId, preflight: state.preflight, verdict: state.verdict, claim: state.claim })
}

async function runAnswer(repoId: RepoId, preflight: GatePreflight, decision: GateDecision, feedback: string | null, skipComment: boolean): Promise<void> {
  setState({ step: 'answering', repoId, number: preflight.number })
  try {
    const response = await window.port.gateAnswer({ repoId, number: preflight.number, decision, feedback, skipComment })
    if (getState().step !== 'answering') return
    setState({ step: 'result', repoId, preflight, decision, feedback, response })
    if (response.kind === 'answered' && response.labels.kind === 'applied') {
      void window.port.boardRefresh({ repoId, source: 'github' })
    }
  } catch (error) {
    console.error('Failed to reach the main process while answering the plan gate', error)
    setState({ step: 'preflight-failed', repoId, number: preflight.number, message: 'Failed to reach the main process.' })
  }
}

function submitApprove(): void {
  if (state.step !== 'reviewing') return
  void runAnswer(state.repoId, state.preflight, 'approve', null, false)
}

function submitFeedback(): void {
  if (state.step !== 'feedback' || state.text.trim() === '') return
  void runAnswer(state.repoId, state.preflight, 'request-changes', state.text, false)
}

/** The one retry affordance that suppresses the comment — a landed comment
 *  followed by an aborted label swap retries the swap alone. */
function retryLabelOnly(): void {
  if (state.step !== 'result') return
  void runAnswer(state.repoId, state.preflight, state.decision, null, true)
}

function tryCommentAgain(): void {
  if (state.step !== 'result') return
  void runAnswer(state.repoId, state.preflight, state.decision, state.feedback, false)
}

/** The result step's own **take the plan gate** shortcut — routes to the
 *  claim step for the same repository, never a second dialog. */
function goToClaimStep(): void {
  if (state.step !== 'result') return
  const { repoId } = state
  setState({ step: 'claim-picking', repos: [], repoId })
  void loadRepos().then((repos) => {
    if (state.step !== 'claim-picking') return
    setState({ ...state, repos })
    void loadClaim(repoId)
  })
}

function closeGateDialog(): void {
  setState({ step: 'closed' })
}

function setField(target: HTMLElement): void {
  const field = target.dataset.field
  if (field === undefined) return
  if (state.step === 'claim-picking' && field === 'repo' && target instanceof HTMLSelectElement) {
    pickRepo(target.value as RepoId)
    return
  }
  if (state.step === 'feedback' && field === 'feedback' && target instanceof HTMLTextAreaElement) {
    setState({ ...state, text: target.value })
  }
}

/** Appended once to `#app`, outside the board's own signature-guarded
 *  rebuild — a poll landing mid-decision cannot blow away a half-written
 *  change request. */
export function initGate(container: HTMLElement): void {
  dialog = buildGateDialog()
  container.appendChild(dialog)
  draw()

  dialog.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const action = target.dataset.action
    if (action === 'gate-cancel') closeGateDialog()
    else if (action === 'gate-claim-take') void setClaim(true)
    else if (action === 'gate-claim-release') void setClaim(false)
    else if (action === 'gate-claim-overwrite') void setClaim(true)
    else if (action === 'gate-claim-delete') void setClaim(false)
    else if (action === 'gate-approve') submitApprove()
    else if (action === 'gate-request-changes') openFeedback()
    else if (action === 'gate-feedback-back') backToReview()
    else if (action === 'gate-feedback-submit') submitFeedback()
    else if (action === 'gate-retry-label') retryLabelOnly()
    else if (action === 'gate-try-again') tryCommentAgain()
    else if (action === 'gate-retry-preflight') retryPreflight()
    else if (action === 'gate-take-claim') goToClaimStep()
  })

  dialog.addEventListener('input', (event) => {
    if (event.target instanceof HTMLElement) setField(event.target)
  })
  dialog.addEventListener('change', (event) => {
    if (event.target instanceof HTMLElement) setField(event.target)
  })

  // A native <dialog>'s own Escape handling fires 'cancel', not 'click' —
  // without this the state would still say 'reviewing' while the dialog
  // itself is invisible.
  dialog.addEventListener('cancel', () => closeGateDialog())
}
