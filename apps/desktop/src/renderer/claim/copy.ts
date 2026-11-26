// Every string Work on's toasts show lives here, one function per union — a new variant is a compile error rather than a silently blank toast. Pure string functions; no DOM here.
import { lastLaunchFailed } from '@/renderer/board/dispatch-failures'
import type { ClaimApplyResponse, ClaimToast, ClaimVerdict } from '@/types/claim'
import type { RepoDispatchStatus } from '@/types/dispatch'
import type { WriteOutcome } from '@/types/writes'
import { mirrorReason } from '@/renderer/lib/mirror-reason'
import { formatClock } from '@/renderer/lib/time'

type Claimable = Extract<ClaimVerdict, { kind: 'claimable' }>
type Refusal = Exclude<ClaimVerdict, { kind: 'claimable' }>

export const CLAIM_TAKE_OVER = 'Take over'
export const CLAIM_LEAVE_IT = 'Leave it'

export function claimingCopy(number: number): string {
  return `Claiming #${String(number)}…`
}

export function takingOverCopy(number: number): string {
  return `Taking over #${String(number)}…`
}

function logins(names: readonly string[]): string {
  return names.length === 0 ? 'no one' : names.map((login) => `@${login}`).join(', ')
}

/** What dispatch will do right after a claim, read from the repository's row in the refresh snapshot. */
export function dispatchLine(repo: string, status: RepoDispatchStatus | undefined): string {
  if (status === undefined) return "Couldn't refresh the board, so it's unclear when planning starts."
  switch (status.owner) {
    case 'none':
      return `Nothing runs ${repo} yet. Run it to start planning.`
    case 'unreadable':
      return `Couldn't tell who runs ${repo} (${status.unreadableMessage ?? 'unknown reason'}), so planning may not start.`
    case 'app':
      break
  }
  switch (status.runState) {
    case 'draining':
      return `${repo} is draining, so nothing new starts. Run it to start planning.`
    case 'paused':
      return `${repo} is stopped. Run it to start planning.`
    case 'dispatching':
      break
  }
  const { state } = status
  switch (state.kind) {
    case 'idle':
      return 'Planning starts now.'
    case 'active':
      return lastLaunchFailed(state.recent) === null ? 'Planning starts now.' : `The last stage launch in ${repo} failed, so planning may not start. Check Needs you.`
    case 'at-capacity':
      return `All ${String(state.limit)} session slots are busy. Planning starts when one frees up.`
    case 'budget-unavailable':
      return `The budget gate can't run (${state.message}), so nothing dispatches until it can.`
  }
}

/** Open blockers, a partial or failed blocker read, and a closed issue — all advisory, never a refusal. */
export function advisoryLine(verdict: Claimable): string | null {
  const sentences: string[] = []
  const { blockers } = verdict
  if (!blockers.ok) {
    sentences.push("Couldn't read its blockers.")
  } else {
    if (blockers.open.length > 0) sentences.push(`Blocked by ${blockers.open.map((b) => `#${String(b.number)}`).join(', ')} — it's planned anyway.`)
    if (blockers.total > blockers.shown) sentences.push(`Showing ${String(blockers.shown)} of ${String(blockers.total)} blockers.`)
  }
  if (verdict.closed) sentences.push("It's closed; claiming didn't reopen it.")
  return sentences.length === 0 ? null : sentences.join(' ')
}

export function refusalCopy(repo: string, number: number, verdict: Refusal): { readonly line: string; readonly note: string | null } {
  switch (verdict.kind) {
    case 'not-found':
      return { line: `#${String(number)} doesn't exist in ${repo}.`, note: null }
    case 'not-an-issue':
      return { line: `#${String(number)} is a pull request.`, note: "Work on claims tickets; a PR enters the pipeline when it's opened." }
    case 'already-claimed':
      return { line: `#${String(number)} is already in the pipeline.`, note: `It carries \`${verdict.markerName}\`. Nothing was written.` }
  }
}

export function claimedTitle(number: number): string {
  return `#${String(number)} claimed and assigned to you.`
}

/** One line per `WriteOutcome` arm. `ownership-unreadable` is named for exhaustiveness, though a claim only writes while this app owns the repository. */
export function writeOutcomeCopy(number: number, outcome: WriteOutcome): { readonly line: string; readonly note: string | null } {
  switch (outcome.kind) {
    case 'applied':
      return { line: claimedTitle(number), note: null }
    case 'no-op':
      return { line: `#${String(number)} already carries those labels.`, note: 'Nothing was written.' }
    case 'precondition-failed': {
      // A claim write only produces the `precondition-failed` arm of `Conflict`; the type is the whole union, so this narrows explicitly.
      const { conflict } = outcome
      const detail =
        conflict.kind === 'precondition-failed'
          ? `Expected ${conflict.expected.join(', ') || 'nothing'}; GitHub has ${conflict.observed.join(', ') || 'nothing'}, read at ${conflict.readAt}.`
          : ''
      return { line: `#${String(number)} moved while you were deciding.`, note: `${detail} Nothing was written.`.trim() }
    }
    case 'write-failed':
      return { line: 'GitHub refused the write.', note: `${outcome.stderr} Nothing else was changed.` }
    case 'verify-failed':
      return { line: `Couldn't re-read #${String(number)} before writing.`, note: `${outcome.message} Nothing was written.` }
    case 'item-unavailable':
      return { line: `Couldn't re-read #${String(number)} before writing.`, note: 'The item is no longer available. Nothing was written.' }
    case 'unresolvable-label':
      return { line: "This repository's label vocabulary doesn't resolve.", note: `Check the following keys in .claude/port.config.json's labels: ${outcome.keys.join(', ')}.` }
    case 'ownership-unreadable':
      return { line: 'Blocked by repository ownership.', note: 'This should be unreachable for Work on — please report it.' }
    case 'state-unsaved':
      return { line: `Couldn't save the claim for #${String(number)}.`, note: `${outcome.message} Nothing was written.` }
    case 'mirror-failed':
      return { line: `Claimed #${String(number)}.`, note: `The GitHub label couldn't be updated — ${mirrorReason(outcome.mirror)}.` }
  }
}

function errorToast(copy: { readonly line: string; readonly note: string | null }): ClaimToast {
  return { tone: 'error', title: copy.line, description: copy.note }
}

function unreachableGitHubToast(message: string): ClaimToast {
  return { tone: 'error', title: "Couldn't reach GitHub.", description: `${message} Nothing was written.` }
}

export function claimedToast(params: { readonly repo: string; readonly number: number; readonly verdict: Claimable; readonly status: RepoDispatchStatus | undefined }): ClaimToast {
  const { repo, number, verdict, status } = params
  const advisory = advisoryLine(verdict)
  const dispatch = dispatchLine(repo, status)
  return { tone: 'success', title: claimedTitle(number), description: advisory === null ? dispatch : `${dispatch} ${advisory}` }
}

export function applyResponseToast(repo: string, number: number, response: ClaimApplyResponse, now: Date): ClaimToast {
  switch (response.kind) {
    case 'moved':
      return {
        tone: 'error',
        title: `#${String(number)} changed on GitHub before the write.`,
        description: `It's now assigned to ${logins(response.current)} (read ${formatClock(response.readAt, now)}). Nothing was written. Work on it again to see where it stands.`,
      }
    case 'refused':
      return errorToast(refusalCopy(repo, number, response.verdict))
    case 'preflight-failed':
      return unreachableGitHubToast(response.message)
    case 'write': {
      const copy = writeOutcomeCopy(number, response.outcome)
      const succeeded = response.outcome.kind === 'applied' || response.outcome.kind === 'no-op' || response.outcome.kind === 'mirror-failed'
      return { tone: succeeded ? 'success' : 'error', title: copy.line, description: copy.note }
    }
  }
}

/** The read that stopped Work on before any write: GitHub unreachable, the number not found, or a verdict that refuses. */
export function preflightToast(repo: string, number: number, response: { readonly kind: 'failed'; readonly message: string } | { readonly kind: 'unresolved' } | { readonly kind: 'refused'; readonly verdict: Refusal }): ClaimToast {
  switch (response.kind) {
    case 'failed':
      return unreachableGitHubToast(response.message)
    case 'unresolved':
      return errorToast(refusalCopy(repo, number, { kind: 'not-found' }))
    case 'refused':
      return errorToast(refusalCopy(repo, number, response.verdict))
  }
}

export function takeOverPrompt(number: number, others: readonly string[]): { readonly title: string; readonly description: string } {
  return { title: `#${String(number)} is assigned to ${logins(others)}.`, description: 'Taking it over removes them, so only your pipeline dispatches it.' }
}
