// Pure selection state for the question card, folded into the answers record the SDK itself expects.
import type { AskQuestion } from '../../../shared/hosting/controls'

export interface QuestionState {
  readonly selected: ReadonlySet<string>
  readonly other: string
}

export type QuestionsState = readonly QuestionState[]

export function initialState(questions: readonly AskQuestion[]): QuestionsState {
  return questions.map(() => ({ selected: new Set<string>(), other: '' }))
}

/** Single-select replaces the selection; multi-select toggles membership. */
export function toggleOption(state: QuestionsState, questionIndex: number, multiSelect: boolean, label: string): QuestionsState {
  return state.map((entry, index) => {
    if (index !== questionIndex) return entry
    if (!multiSelect) return { ...entry, selected: new Set([label]) }
    const next = new Set(entry.selected)
    if (next.has(label)) next.delete(label)
    else next.add(label)
    return { ...entry, selected: next }
  })
}

export function setOther(state: QuestionsState, questionIndex: number, value: string): QuestionsState {
  return state.map((entry, index) => (index === questionIndex ? { ...entry, other: value } : entry))
}

function answerFor(question: AskQuestion, entry: QuestionState): string {
  // Option order, never Set insertion order, so toggling out of order still joins consistently.
  const parts = question.options.map((option) => option.label).filter((label) => entry.selected.has(label))
  const other = entry.other.trim()
  if (other !== '') parts.push(other)
  return parts.join(', ')
}

// Single-select is the label or the Other text; multi-select joins labels and Other with ", ".
export function toAnswers(questions: readonly AskQuestion[], state: QuestionsState): Record<string, string> {
  const answers: Record<string, string> = {}
  questions.forEach((question, index) => {
    const entry = state[index]
    if (entry === undefined) return
    answers[question.question] = answerFor(question, entry)
  })
  return answers
}

// Every question has a non-empty answer.
export function isComplete(questions: readonly AskQuestion[], state: QuestionsState): boolean {
  return questions.every((question, index) => answerFor(question, state[index] ?? { selected: new Set(), other: '' }) !== '')
}
