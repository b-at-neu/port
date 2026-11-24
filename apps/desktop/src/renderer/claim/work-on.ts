// Work on's claim decisions — what each read or write result means for the flow. Pure; the hook runs the calls.
import { applyResponseToast, claimedToast, preflightToast, takeOverPrompt } from '@/renderer/claim/copy'
import type { ClaimApplyResponse, ClaimPreflightResponse, ClaimToast, ClaimVerdict } from '@/types/claim'
import type { RepoDispatchStatus } from '@/types/dispatch'
import type { RepoId } from '@/utils/repos'

type Claimable = Extract<ClaimVerdict, { kind: 'claimable' }>

export type WorkOnStep =
  | { readonly kind: 'stop'; readonly toast: ClaimToast }
  | { readonly kind: 'ask-take-over'; readonly prompt: { readonly title: string; readonly description: string }; readonly confirmedAssignees: readonly string[]; readonly verdict: Claimable }
  | { readonly kind: 'apply'; readonly confirmedAssignees: readonly string[]; readonly verdict: Claimable }

/** Every toast for one row shares this id, so a later state replaces an earlier one. */
export function workOnToastId(repoId: RepoId, number: number): string {
  return `work-on:${repoId}:${String(number)}`
}

export function afterPreflight(repo: string, number: number, response: ClaimPreflightResponse): WorkOnStep {
  if (response.kind !== 'resolved') return { kind: 'stop', toast: preflightToast(repo, number, response) }
  const { preflight, verdict } = response
  if (verdict.kind !== 'claimable') return { kind: 'stop', toast: preflightToast(repo, number, { kind: 'refused', verdict }) }
  const confirmedAssignees = preflight.assignees
  if (verdict.assigneeSituation === 'others') return { kind: 'ask-take-over', prompt: takeOverPrompt(number, verdict.others), confirmedAssignees, verdict }
  return { kind: 'apply', confirmedAssignees, verdict }
}

/** True when the write landed, so the dispatch status is worth reading. */
export function isClaimed(response: ClaimApplyResponse): boolean {
  return response.kind === 'write' && (response.outcome.kind === 'applied' || response.outcome.kind === 'no-op')
}

export function afterApply(params: {
  readonly repo: string
  readonly number: number
  readonly verdict: Claimable
  readonly response: ClaimApplyResponse
  readonly status: RepoDispatchStatus | undefined
  readonly now: Date
}): ClaimToast {
  const { repo, number, verdict, response, status, now } = params
  if (response.kind === 'write' && response.outcome.kind === 'applied') return claimedToast({ repo, number, verdict, status })
  return applyResponseToast(repo, number, response, now)
}
