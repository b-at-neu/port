// Every string the plan gate dialog renders lives here, one function per
// union — a new variant is a compile error rather than a silently blank
// line, the same rule `claim/copy.ts`'s and `board/copy.ts`'s own headers
// state. Pure string functions; no DOM here. The claim-step lines are
// `docs/COORDINATION.md`'s own decided copy, verbatim — a mismatch there is
// this file's own regression, pinned by `scripts/checks/desktop-gate.ts`.
import type { GateAnswerResponse, GateDecision, GateVerdict } from '../../../shared/gate/types'
import type { ClaimRead } from '../../../shared/writes/types'

export interface ClaimLineCopy {
  readonly line: string
  readonly note: string | null
  readonly action: 'take' | 'release' | 'overwrite' | 'delete' | null
}

/** The Claim step's own copy — `docs/COORDINATION.md`'s "Detecting and
 *  presenting a conflict" section, verbatim, since the Reviewing step
 *  repeats this same line rather than re-deriving it. */
export function claimLineCopy(claim: ClaimRead): ClaimLineCopy {
  switch (claim.state) {
    case 'absent':
      return { line: "The plan gate isn't claimed here.", note: 'The cockpit is still answering it in your terminal.', action: 'take' }
    case 'held': {
      const unknown = claim.unknownScopes.length > 0 ? ` · it also claims \`${claim.unknownScopes.join('`, `')}\`, which this app doesn't recognize.` : ''
      return {
        line: `Plan gate claimed by \`${claim.owner}\` since ${claim.claimedAt}.`,
        note: `The cockpit stands down from \`plan review\` in this checkout.${unknown}`,
        action: 'release',
      }
    }
    case 'unreadable':
      return {
        line: `\`${claim.path}\` can't be read (${claim.message}).`,
        note: "Until it's valid or removed, this app and the cockpit both stand down from the plan gate — nothing will answer an issue at `plan review`. Fix or delete the file.",
        action: 'overwrite',
      }
  }
}

export function isClaimHeldForPlanGate(claim: ClaimRead): boolean {
  return claim.state === 'held' && claim.scopes.includes('plan-gate')
}

export function autoPlanNoteCopy(): string {
  return 'Opted in with auto-approve. The cockpit would have approved this without asking — it is waiting because the plan gate is claimed here.'
}

export function assigneeNoteCopy(login: string): string {
  return `Assigned to @${login}. The claim covers this checkout, so answering here is still yours to make.`
}

export function noPlanNoteCopy(): string {
  return "No plan section in this issue's body — showing the whole body."
}

export interface SessionRequiredCopy {
  readonly banner: string
  readonly note: string
  readonly launchLine: string
}

/** The `SESSION REQUIRED` banner — names `/port:implement` and the fact that
 *  no agent picks it up, literally, so `scripts/checks/desktop-gate.ts` can
 *  pin the consequence mechanically. */
export function sessionRequiredCopy(number: number, title: string, reason: string): SessionRequiredCopy {
  return {
    banner: "⚠️ You'll run this one yourself.",
    note: `The plan is marked session-required: ${reason}. Approving labels it \`plan approved\`, but no agent will ever pick it up — open a named session and run /port:implement ${String(number)}.`,
    launchLine: `claude -n "#${String(number)}: ${title}"`,
  }
}

export function primaryApproveLabel(sessionRequired: boolean): string {
  return sessionRequired ? "Approve — I'll run it myself" : 'Approve'
}

export function feedbackHint(number: number): string {
  return `Posted as a comment on #${String(number)}, then the issue moves to \`plan changes requested\`. plan-agent reads your comment as the change request.`
}

export interface ResultCopy {
  readonly line: string
  readonly note: string | null
  readonly actions: readonly ('retry-label' | 'show-state' | 'try-again' | 'take-claim' | 'dismiss')[]
}

/** One line plus a note, exhaustive over `GateAnswerResponse` (the plan's
 *  own **Result step** table). `sessionRequired` only changes the `approve`/
 *  `applied` line's own wording — announce-instead-of-dispatch, rather than
 *  "a cockpit dispatches next". */
export function resultCopy(params: { readonly number: number; readonly decision: GateDecision; readonly response: GateAnswerResponse; readonly sessionRequired: boolean }): ResultCopy {
  const { number, decision, response, sessionRequired } = params
  const n = String(number)

  switch (response.kind) {
    case 'refused': {
      const refusal = refusedVerdictCopy(number, response.verdict)
      return { line: refusal.line, note: refusal.note, actions: ['dismiss'] }
    }
    case 'preflight-failed':
      return { line: `Couldn't reach GitHub.`, note: response.message, actions: ['dismiss'] }
    case 'comment-failed':
      return {
        line: `Your feedback wasn't posted.`,
        note: response.comment.kind === 'write-failed' ? `${response.comment.stderr} Nothing was changed.` : 'Nothing was changed.',
        actions: ['try-again'],
      }
    case 'answered':
      return answeredCopy(n, decision, response, sessionRequired)
  }
}

/** The refusal line — reused both by an answer attempt's own `refused` arm
 *  and by the standalone Refused step (a preflight whose verdict was never
 *  `answerable` to begin with), so the two present identically. */
export function refusedVerdictCopy(number: number, verdict: Exclude<GateVerdict, { kind: 'answerable' }>): { readonly line: string; readonly note: string | null } {
  const n = String(number)
  switch (verdict.kind) {
    case 'not-found':
      return { line: `#${n} doesn't exist.`, note: 'The issue no longer exists.' }
    case 'not-an-issue':
      return { line: `#${n} is a pull request now.`, note: null }
    case 'not-at-plan-review':
      return { line: `#${n} is no longer at \`plan review\`.`, note: `GitHub has ${verdict.observed.join(', ') || 'no labels'}.` }
  }
}

function answeredCopy(n: string, decision: GateDecision, response: Extract<GateAnswerResponse, { kind: 'answered' }>, sessionRequired: boolean): ResultCopy {
  const { comment, labels } = response

  if (labels.kind === 'applied') {
    if (decision === 'approve') {
      const line = `#${n} approved.`
      const note = sessionRequired
        ? 'Session-required — this announces the /port:implement command instead of dispatching.'
        : 'A cockpit assigned to you dispatches implementation on its next tick.'
      return { line, note, actions: ['dismiss'] }
    }
    return { line: `#${n} moved to \`plan changes requested\`.`, note: 'Your feedback is on the issue.', actions: ['dismiss'] }
  }

  if (comment !== null && comment.kind === 'applied') {
    // The comment landed but the label swap itself aborted — presented
    // exactly as that, per the plan's own "fails toward saying precisely
    // what landed" rule.
    const detail = labelAbortDetail(labels)
    return { line: `Your feedback is posted on #${n}, but the label didn't move.`, note: `${detail} Nothing else was written.`, actions: ['retry-label', 'show-state'] }
  }

  return labelOnlyCopy(n, labels)
}

function labelAbortDetail(labels: Extract<GateAnswerResponse, { kind: 'answered' }>['labels']): string {
  switch (labels.kind) {
    case 'precondition-failed':
      return labels.conflict.kind === 'precondition-failed'
        ? `Expected ${labels.conflict.expected.join(', ') || 'nothing'}; GitHub has ${labels.conflict.observed.join(', ') || 'nothing'}, read at ${labels.conflict.readAt}.`
        : ''
    case 'write-failed':
      return labels.stderr
    case 'unclaimed-scope':
    case 'claim-unreadable':
      return 'The plan gate is no longer claimed here.'
    case 'unresolvable-label':
      return `Check the following keys in .claude/port.config.json's labels: ${labels.keys.join(', ')}.`
    case 'verify-failed':
      return labels.message
    case 'item-unavailable':
      return 'The item is no longer available.'
    case 'no-op':
    case 'applied':
      return ''
  }
}

function labelOnlyCopy(n: string, labels: Extract<GateAnswerResponse, { kind: 'answered' }>['labels']): ResultCopy {
  switch (labels.kind) {
    case 'precondition-failed': {
      const detail =
        labels.conflict.kind === 'precondition-failed'
          ? `Expected ${labels.conflict.expected.join(', ') || 'nothing'}; GitHub has ${labels.conflict.observed.join(', ') || 'nothing'}, read at ${labels.conflict.readAt}.`
          : ''
      return { line: `#${n} moved while you were deciding.`, note: `${detail} Nothing was written.`.trim(), actions: ['show-state'] }
    }
    case 'no-op':
      return { line: `#${n} already carries that label.`, note: 'Nothing was written.', actions: ['dismiss'] }
    case 'unclaimed-scope':
    case 'claim-unreadable':
      return { line: 'The plan gate is not claimed here.', note: 'Nothing was written.', actions: ['take-claim'] }
    case 'write-failed':
      return { line: 'GitHub refused the write.', note: `${labels.stderr} Nothing else was changed.`, actions: ['dismiss'] }
    case 'verify-failed':
      return { line: `Couldn't re-read #${n} before writing.`, note: `${labels.message} Nothing was written.`, actions: ['dismiss'] }
    case 'item-unavailable':
      return { line: `Couldn't re-read #${n} before writing.`, note: 'The item is no longer available. Nothing was written.', actions: ['dismiss'] }
    case 'unresolvable-label':
      return { line: "This repository's label vocabulary doesn't resolve.", note: `Check the following keys in .claude/port.config.json's labels: ${labels.keys.join(', ')}.`, actions: ['dismiss'] }
    case 'applied':
      // Unreachable from this branch (handled above) — exhaustive for the
      // type checker only.
      return { line: '', note: null, actions: ['dismiss'] }
  }
}
