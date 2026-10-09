// Every copy string for the controls bar, question card, and plan card.

export const QUESTION_HEADING = 'Claude is asking'
export const QUESTION_SEND = 'Send answers'
export const QUESTION_SKIP = 'Skip question'
export const QUESTION_SKIPPED_MESSAGE = 'The operator skipped this question.'
export const QUESTION_OTHER_LABEL = 'Other'

// Every question renders at once in the card, so this names the count rather than paging through them.
export function questionProgress(total: number): string {
  return total <= 1 ? QUESTION_HEADING : `${QUESTION_HEADING} — 1 of ${String(total)}`
}

export function questionAnswerFailed(kind: string): string {
  return `Couldn't send your answers: ${kind}.`
}

export const PLAN_HEADING = "Claude's plan"
export const PLAN_EMPTY = "Claude didn't include a plan text."
export const PLAN_FEEDBACK_PLACEHOLDER = 'What should Claude change?'
export const PLAN_APPROVE_ACCEPT_EDITS = 'Approve and accept edits'
export const PLAN_APPROVE_ASK = 'Approve, ask before edits'
export const PLAN_KEEP_PLANNING = 'Keep planning'
export const PLAN_SENDING = 'Sending…'

export function planAnswerFailed(kind: string): string {
  return `Couldn't send your decision: ${kind}.`
}

export const COMPOSER_QUESTION_PLACEHOLDER = "Answer Claude's question above."
export const COMPOSER_PLAN_PLACEHOLDER = 'Review the plan above.'

export function modelLoadFailed(message: string): string {
  return `Couldn't read the model list: ${message}`
}

export function controlsChangeFailed(reason: string): string {
  return `Couldn't change the model: ${reason}.`
}

export function modeToast(label: string): string {
  return `Mode: ${label}`
}

export const MODELS_LOADING = 'Loading models…'

export function sidebarDotLabel(interactionKind: 'question' | 'plan'): string {
  return interactionKind === 'question' ? 'Claude is asking a question' : 'Plan ready for review'
}
