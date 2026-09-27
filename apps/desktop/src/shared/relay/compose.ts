// Pure reply composition (#107) — every question answered, or `null`, so the
// Copy button's disabled state and this function agree by construction
// rather than by two separately maintained rules.
import type { RelayPending } from './types'

/** `#<n>` when the candidate resolved a ticket number, `this item` when it
 *  did not — a pending relay with no matched number still composes a
 *  readable header. */
function labelOf(pending: RelayPending): string {
  return pending.number !== null ? `#${String(pending.number)}` : 'this item'
}

/**
 * `answers[i]` answers `pending.questions[i]` for the `questions` kind, or is
 * the single decision text for `blocked` — `usage-limit` never composes
 * (there is nothing to answer). Returns `null` whenever any required answer
 * is blank, or the answer count does not match the question count, so a
 * caller never has to duplicate that validation to decide whether Copy is
 * enabled.
 */
export function composeReply(pending: RelayPending, answers: readonly string[]): string | null {
  const label = labelOf(pending)

  if (pending.kind === 'questions') {
    if (answers.length !== pending.questions.length) return null
    if (answers.some((answer) => answer.trim() === '')) return null
    const lines = pending.questions.map((question, index) => `${String(question.index + 1)}. ${answers[index] ?? ''}`)
    return [`Answers for ${label} (${pending.stage}):`, ...lines].join('\n')
  }

  if (pending.kind === 'blocked') {
    const decision = (answers[0] ?? '').trim()
    if (decision === '') return null
    return [`Decision on the blocker for ${label} (${pending.stage}):`, decision].join('\n')
  }

  return null
}
