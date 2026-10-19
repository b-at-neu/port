// Every string the decision dialog renders — one function per union, pure.
import { LABEL_DEFAULTS } from '@/utils/labels/defaults'
import type { ItemDecisionResult, OperatorDecision, RebaseDecision, RebaseOption, RebasePick, ReviseContext, UnblockContext, UnblockRoute } from '@/types/actions'

function labelNameOf(key: string): string {
  return LABEL_DEFAULTS.find((def) => def.key === key)?.name ?? key
}

export function dialogTitle(decision: OperatorDecision, number: number): string {
  return decision === 'unblock' ? `Unblock PR #${String(number)}` : `Request changes on PR #${String(number)}`
}

export function unblockReasonLine(context: UnblockContext): string {
  return context.reason !== null ? `Why it stopped: ${context.reason}` : "No escalation comment in this PR's last 20 comments. Open the PR to see why it stopped."
}

export function unblockConsequence(context: UnblockContext): string {
  if (context.decisions.length > 0) {
    return `Unblocking records your choices on the PR as "## Gate cleared", removes "${labelNameOf('needsHuman')}", and sends it to revision. Revision redoes the rebase with them on the next tick.`
  }
  return `Unblocking says you've handled this. port posts "## Gate cleared" on the PR, removes "${labelNameOf('needsHuman')}", and the next tick picks it up.`
}

export function rebaseLegend(decision: RebaseDecision): string {
  return `${decision.id} · \`${decision.path}\``
}

export function rebaseOptionLabel(option: RebaseOption): string {
  return `${option.letter} — ${option.label}`
}

export function picksHint(decisions: readonly RebaseDecision[], chosen: Readonly<Record<string, string>>): string | null {
  const missing = decisions.find((d) => chosen[d.id] === undefined)
  return missing === undefined ? null : `Pick an option for ${missing.id}.`
}

export function picksChosenLine(picks: readonly RebasePick[]): string {
  return picks.map((pick) => `${pick.id} ${pick.letter}`).join(', ')
}

export function unblockCapNote(context: UnblockContext): string | null {
  if (context.cyclesUsed < context.cap) return null
  return `This PR has used all ${String(context.cap)} review cycles. Send to revision grants it one more — only this PR; the cap elsewhere is unchanged.`
}

export function reviseConsequence(context: ReviseContext): string {
  return `This takes the approval back, posts your note as "## Changes requested", and sends the PR to revision. ${String(context.cyclesUsed)} of ${String(context.cap)} review cycles used.`
}

export function reviseNoteHint(problem: 'empty' | 'too-long' | 'only-sha' | null): string | null {
  if (problem === 'empty') return 'Say what should change. port posts it word for word.'
  if (problem === 'only-sha') return 'Add the change itself — a note that only names the commit gives revision nothing to do.'
  if (problem === 'too-long') return 'Keep it under 10,000 characters.'
  return null
}

function refusalNote(response: Extract<ItemDecisionResult, { readonly reason: 'refused' }>): string | null {
  if (response.refusal === 'note-invalid') return reviseNoteHint(response.problem as Parameters<typeof reviseNoteHint>[0])
  if (response.refusal === 'picks-invalid') return 'The escalation changed since you opened this. Close and reopen to see the current decisions.'
  return null
}

interface DecisionResultCopy {
  readonly line: string
  readonly note: string | null
  readonly offerLabelOnly: boolean
}

/** The Result step (the plan's own **UX states**) — exhaustive over
 *  `ItemDecisionResult`. `route` disambiguates `unblock`'s own two lines. */
export function decisionResultCopy(params: {
  readonly number: number
  readonly decision: OperatorDecision
  readonly route: UnblockRoute | null
  readonly picks: readonly RebasePick[] | null
  readonly response: ItemDecisionResult
}): DecisionResultCopy {
  const { number, decision, route, picks, response } = params
  const n = String(number)

  if (!response.ok) {
    switch (response.reason) {
      case 'moved':
        return { line: `PR #${n} is at "${response.observed}" now, not "${response.expected}". Nothing was written — the board will catch up.`, note: null, offerLabelOnly: false }
      case 'not-owned':
        return { line: `@${response.owners[0] ?? 'someone else'} owns PR #${n}. port only acts on your own items.`, note: null, offerLabelOnly: false }
      case 'viewer-unknown':
        return { line: "Can't tell which account you're signed in as, so ownership can't be checked.", note: null, offerLabelOnly: false }
      case 'repo-unavailable':
        return { line: "Can't read this repository right now. Nothing was written.", note: null, offerLabelOnly: false }
      case 'refused':
        return {
          line: `PR #${n} can no longer be ${decision === 'unblock' ? 'unblocked' : 'sent back'} that way.`,
          note: refusalNote(response),
          offerLabelOnly: false,
        }
      case 'verify-failed':
        return { line: `Couldn't re-read PR #${n} before writing — ${response.message}. Nothing was written.`, note: null, offerLabelOnly: false }
      case 'comment-failed':
        return {
          line: `Couldn't post the comment on PR #${n} — ${response.comment.kind === 'write-failed' ? response.comment.stderr : 'the write failed'}. Nothing was changed.`,
          note: null,
          offerLabelOnly: false,
        }
    }
  }

  const { comment, labels } = response
  if (labels.kind === 'applied') {
    if (decision === 'unblock') {
      const target = route === 'revision' ? `"${labelNameOf('needsRevision')}"` : `"${labelNameOf('readyForReview')}"`
      const verb = route === 'revision' ? 'dispatches revision' : 'dispatches review'
      const chosen = picks !== null && picks.length > 0 ? ` with ${picksChosenLine(picks)}` : ''
      return { line: `PR #${n} is unblocked and at ${target}${chosen}. "## Gate cleared" is posted; the next tick ${verb}.`, note: null, offerLabelOnly: false }
    }
    return {
      line: `PR #${n} is back at "${labelNameOf('needsRevision')}". Your note is posted as "## Changes requested" and the approval is off. The next tick dispatches revision.`,
      note: null,
      offerLabelOnly: false,
    }
  }

  if (comment !== null && comment.kind === 'applied') {
    const detail = labels.kind === 'precondition-failed' && labels.conflict.kind === 'precondition-failed' ? `now: ${labels.conflict.observed.join(', ') || 'nothing'}` : null
    if (labels.kind === 'precondition-failed') {
      return {
        line: `Posted "## Gate cleared" on PR #${n}, but its labels moved before the swap${detail !== null ? ` (${detail})` : ''}. Nothing else changed — the comment stays as the record.`,
        note: null,
        offerLabelOnly: false,
      }
    }
    return { line: `Posted the comment on PR #${n}, but the label didn't move.`, note: 'Nothing else was written.', offerLabelOnly: true }
  }

  return { line: `Couldn't write PR #${n}'s labels.`, note: 'Nothing was changed.', offerLabelOnly: false }
}
