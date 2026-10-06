// The claim dialog's state machine (#93, #319) — a `useSyncExternalStore`
// store now, with `claim/dialog.tsx` (a shadcn `Dialog`) as its one renderer
// in place of the deleted `view.ts`'s native `<dialog>`. Every write goes
// through `data/invoke.ts`'s `invoke`, never `window.port` directly.
import { invoke } from '../data/invoke'
import { isReadyRepo } from '../../../shared/repos'
import type { RepoId } from '../../../shared/repos'
import type { ClaimPreflight, ClaimVerdict, PlanGateChoice } from '../../../shared/claim/types'
import type { WriteOutcome } from '../../../shared/writes/types'

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

async function loadRepos(): Promise<readonly ReadyRepo[]> {
  const result = await invoke('repos:list')
  if (!result.ok) return []
  return result.repositories.filter(isReadyRepo).map((entry) => ({ id: entry.id, repo: entry.config.repo }))
}

export function openClaimDialog(): void {
  onClaimed = null
  setState({ step: 'picking', repos: [], repoId: null, number: '', error: null })
  void loadRepos().then((repos) => {
    if (state.step !== 'picking') return
    const onlyRepo = repos.length === 1 ? repos[0] : undefined
    setState({ ...state, repos, repoId: state.repoId ?? onlyRepo?.id ?? null })
  })
}

export function closeClaimDialog(): void {
  onClaimed = null
  setState({ step: 'closed' })
}

function parseNumber(raw: string): number | null {
  const trimmed = raw.trim().replace(/^#/, '')
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return Number.isInteger(value) && value > 0 ? value : null
}

// The preflight fetch and its classification, shared by the picker (`submitPick`) and a preset entry (`openClaimDialogFor`).
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

export function setClaimRepo(repoId: RepoId): void {
  if (state.step !== 'picking') return
  setState({ ...state, repoId, error: null })
}

export function setClaimNumber(number: string): void {
  if (state.step !== 'picking') return
  setState({ ...state, number, error: null })
}

export function setPlanGate(planGate: PlanGateChoice): void {
  if (state.step !== 'reviewing') return
  setState({ ...state, planGate })
}

export function submitPick(): void {
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
  void runPreflight(repoId, repo, parsed, 'review')
}

export interface OpenClaimDialogForParams {
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

export function backToPick(): void {
  if (state.step !== 'reviewing') return
  setState({ step: 'picking', repos: [], repoId: state.repoId, number: String(state.preflight.number), error: null })
  void loadRepos().then((repos) => {
    if (state.step !== 'picking') return
    setState({ ...state, repos })
  })
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
 *  `write-result` carrying `precondition-failed` (the write-level race). */
export function retryPreflight(): void {
  if (state.step === 'moved') {
    const { repoId, number } = state
    setState({ step: 'picking', repos: [], repoId, number: String(number), error: null })
    submitPick()
    return
  }
  if (state.step === 'write-result' && state.outcome.kind === 'precondition-failed') {
    const { repoId, number } = state
    setState({ step: 'picking', repos: [], repoId, number: String(number), error: null })
    submitPick()
  }
}
