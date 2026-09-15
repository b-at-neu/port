// Every string the claim dialog renders lives here, one function per union —
// a new variant is a compile error rather than a silently blank line, the
// same rule `board/copy.ts`'s own header states. Pure string functions; no
// DOM here.
import type { ClaimVerdict } from '../../../shared/claim/types'
import type { WriteOutcome } from '../../../shared/writes/types'

export function blockersCopy(verdict: Extract<ClaimVerdict, { kind: 'claimable' }>): { readonly line: string; readonly note: string } | null {
  const { blockers } = verdict
  if (!blockers.ok) return { line: "Couldn't read this issue's blockers.", note: `${blockers.reason}. Claiming is still allowed.` }
  if (blockers.open.length === 0) return null
  const names = blockers.open.map((b) => `#${String(b.number)}`).join(', ')
  const truncation = blockers.total > blockers.shown ? ` Showing ${String(blockers.shown)} of ${String(blockers.total)}.` : ''
  return { line: `Blocked by ${names}.${truncation}`, note: 'The pipeline will plan and implement this anyway — the dependency is advisory.' }
}

export function assigneeCopy(verdict: Extract<ClaimVerdict, { kind: 'claimable' }>): { readonly line: string; readonly note: string } | null {
  if (verdict.assigneeSituation === 'unassigned') return null
  if (verdict.assigneeSituation === 'mine') return { line: 'Already assigned to you.', note: '' }
  const names = verdict.others.map((login) => `@${login}`).join(', ')
  return { line: `Assigned to ${names}.`, note: 'Two assignees means two cockpits both dispatch, so claiming takes it over — they are removed.' }
}

export function closedCopy(number: number): { readonly line: string; readonly note: string } {
  return { line: `#${String(number)} is closed.`, note: "Claiming won't reopen it." }
}

export function primaryButtonLabel(verdict: Extract<ClaimVerdict, { kind: 'claimable' }>): string {
  return verdict.assigneeSituation === 'others' ? 'Take over and claim' : 'Claim'
}

export function refusalCopy(repo: string, number: number, verdict: ClaimVerdict): { readonly line: string; readonly note: string | null } {
  switch (verdict.kind) {
    case 'not-found':
      return { line: `#${String(number)} doesn't exist in ${repo}.`, note: null }
    case 'not-an-issue':
      return { line: `#${String(number)} is a pull request.`, note: 'Opt-in claims an issue; a pull request enters the pipeline when impl-agent opens it.' }
    case 'already-claimed':
      return { line: `#${String(number)} is already in the pipeline.`, note: `It carries \`${verdict.markerName}\`. Claiming it again would leave two stage labels on one issue, which every stage agent treats as impossible and aborts on.` }
    case 'claimable':
      return { line: '', note: null }
  }
}

export function preflightFailedCopy(message: string): { readonly line: string; readonly note: string } {
  return { line: "Couldn't reach GitHub.", note: message }
}

export function movedCopy(current: readonly string[], readAt: string): { readonly line: string; readonly note: string } {
  const currentText = current.length === 0 ? 'no one' : current.map((login) => `@${login}`).join(', ')
  return { line: 'Moved while you were deciding.', note: `GitHub now shows it assigned to ${currentText}, read at ${readAt}. Nothing was written.` }
}

/** One line per `WriteOutcome` arm (the plan's own **Results** table) —
 *  `unclaimed-scope`/`claim-unreadable` are rendered by name for
 *  exhaustiveness, though unreachable here: opt-in touches no plan-gate
 *  key. */
export function writeOutcomeCopy(number: number, outcome: WriteOutcome): { readonly line: string; readonly note: string | null } {
  switch (outcome.kind) {
    case 'applied':
      return { line: `#${String(number)} claimed and assigned to you.`, note: 'A cockpit assigned to you will plan it on its next tick.' }
    case 'no-op':
      return { line: `#${String(number)} already carries those labels.`, note: 'Nothing was written.' }
    case 'precondition-failed': {
      // `applyLabels` only ever produces the `precondition-failed` arm of
      // `Conflict` here (`shared/writes/types.ts`'s own comment on
      // `WriteOutcome`) — the other two arms belong to the reconciler and
      // are unreachable from a claim write, but the type is the whole
      // union, so this still narrows explicitly rather than assuming it.
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
    case 'unclaimed-scope':
    case 'claim-unreadable':
      return { line: 'Blocked by the plan-gate claim.', note: 'This should be unreachable for opt-in — please report it.' }
  }
}
