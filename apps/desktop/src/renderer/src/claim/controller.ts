// The claim dialog's state machine and its own event wiring (#93) — the
// dialog owns its `data-action="claim-*"` handling directly, rather than
// routing through `main.ts`'s delegated board/repositories handler, so the
// entry point there stays exactly one branch (`action?.startsWith('claim-')`
// opening it).
import type { RepoId, RepositoryEntry } from '../../../shared/repos'
import type { ClaimPreflight, ClaimVerdict, PlanGateChoice } from '../../../shared/claim/types'
import type { WriteOutcome } from '../../../shared/writes/types'
import { buildClaimDialog, renderClaimDialog } from './view'

export interface ReadyRepo {
  readonly id: RepoId
  readonly repo: string
}

export type ClaimState =
  | { readonly step: 'closed' }
  | { readonly step: 'picking'; readonly repos: readonly ReadyRepo[]; readonly repoId: RepoId | null; readonly number: string; readonly error: string | null }
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
  | { readonly step: 'write-result'; readonly number: number; readonly outcome: WriteOutcome }

let state: ClaimState = { step: 'closed' }
let dialog: HTMLDialogElement | null = null

function draw(): void {
  if (dialog) renderClaimDialog(dialog, state)
}

function setState(next: ClaimState): void {
  state = next
  draw()
}

/** Reads `state` through an indirection `await`-narrowing can't see through
 *  — a `let` read directly after an `await` still carries the narrowing
 *  from a guard earlier in the same function, even though `setState` (a
 *  separate function) may have reassigned it in between. Every staleness
 *  check below (`did the dialog move on to something else while this
 *  request was in flight?`) needs the *current* value, not the one TS
 *  narrowed against before the `await`. */
function getState(): ClaimState {
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

export function openClaimDialog(): void {
  setState({ step: 'picking', repos: [], repoId: null, number: '', error: null })
  void loadRepos().then((repos) => {
    if (state.step !== 'picking') return
    setState({ ...state, repos, repoId: state.repoId ?? repos[0]?.id ?? null })
  })
}

function closeClaimDialog(): void {
  setState({ step: 'closed' })
}

function parseNumber(raw: string): number | null {
  const trimmed = raw.trim().replace(/^#/, '')
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return Number.isInteger(value) && value > 0 ? value : null
}

async function submitPick(): Promise<void> {
  if (state.step !== 'picking') return
  const { repoId, number } = state
  const parsed = parseNumber(number)
  if (repoId === null) {
    setState({ ...state, error: 'Pick a repository.' })
    return
  }
  if (parsed === null) {
    setState({ ...state, error: 'Enter a positive issue number.' })
    return
  }
  const repo = state.repos.find((r) => r.id === repoId)?.repo ?? repoId
  setState({ step: 'loading', repoId, repo, number: parsed })
  try {
    const response = await window.port.claimPreflight({ repoId, number: parsed })
    if (getState().step !== 'loading') return
    if (response.kind === 'failed') {
      setState({ step: 'preflight-failed', repoId, repo, number: parsed, message: response.message })
      return
    }
    if (response.kind === 'unresolved') {
      setState({ step: 'refused', repo, number: parsed, verdict: { kind: 'not-found' }, url: null })
      return
    }
    if (response.verdict.kind !== 'claimable') {
      setState({ step: 'refused', repo, number: parsed, verdict: response.verdict, url: response.preflight.url })
      return
    }
    setState({ step: 'reviewing', repoId, repo, preflight: response.preflight, verdict: response.verdict, planGate: 'review' })
  } catch (error) {
    console.error('Failed to reach the main process while reading a claim preflight', error)
    setState({ step: 'preflight-failed', repoId, repo, number: parsed, message: 'Failed to reach the main process.' })
  }
}

function backToPick(): void {
  if (state.step !== 'reviewing') return
  setState({ step: 'picking', repos: [], repoId: state.repoId, number: String(state.preflight.number), error: null })
  void loadRepos().then((repos) => {
    if (state.step !== 'picking') return
    setState({ ...state, repos })
  })
}

async function confirmClaim(): Promise<void> {
  if (state.step !== 'reviewing') return
  const { repoId, repo, preflight, planGate } = state
  setState({ step: 'applying', number: preflight.number })
  try {
    const response = await window.port.claimApply({ repoId, number: preflight.number, planGate, confirmedAssignees: preflight.assignees })
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
    setState({ step: 'write-result', number: preflight.number, outcome: response.outcome })
    if (response.outcome.kind === 'applied' || response.outcome.kind === 'no-op') {
      void window.port.boardRefresh({ repoId, source: 'github' })
    }
  } catch (error) {
    console.error('Failed to reach the main process while applying a claim', error)
    setState({ step: 'preflight-failed', repoId, repo, number: preflight.number, message: 'Failed to reach the main process.' })
  }
}

function retryPreflight(): void {
  if (state.step !== 'moved') return
  const { repoId, number } = state
  setState({ step: 'picking', repos: [], repoId, number: String(number), error: null })
  void submitPick()
}

function setField(target: HTMLElement): void {
  const field = target.dataset.field
  if (field === undefined) return
  if (state.step === 'picking') {
    if (field === 'repo' && target instanceof HTMLSelectElement) setState({ ...state, repoId: target.value as RepoId, error: null })
    else if (field === 'number' && target instanceof HTMLInputElement) setState({ ...state, number: target.value, error: null })
    return
  }
  if (state.step === 'reviewing' && field === 'planGate' && target instanceof HTMLInputElement) {
    setState({ ...state, planGate: target.value as PlanGateChoice })
  }
}

/** Appended once to `#app`, outside the board's own signature-guarded
 *  rebuild — a poll landing mid-decision cannot blow away a half-filled
 *  form, since nothing here re-renders on a board tick. */
export function initClaim(container: HTMLElement): void {
  dialog = buildClaimDialog()
  container.appendChild(dialog)
  draw()

  dialog.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const action = target.dataset.action
    if (action === 'claim-cancel') closeClaimDialog()
    else if (action === 'claim-submit') void submitPick()
    else if (action === 'claim-back') backToPick()
    else if (action === 'claim-confirm') void confirmClaim()
    else if (action === 'claim-retry-preflight') retryPreflight()
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
  dialog.addEventListener('cancel', () => closeClaimDialog())
}
