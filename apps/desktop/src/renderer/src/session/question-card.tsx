// The AskUserQuestion card: radio rows for single-select, checkboxes for multi-select, plus an Other field.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { AskQuestion } from '../../../shared/hosting/controls'
import { initialState, isComplete, setOther, toAnswers, toggleOption } from './question-model'
import type { QuestionsState } from './question-model'
import { QUESTION_OTHER_LABEL, QUESTION_SEND, QUESTION_SKIP, questionAnswerFailed, questionProgress } from './interaction-copy'

export interface QuestionCardProps {
  readonly questions: readonly AskQuestion[]
  readonly sending: boolean
  readonly error: string | null
  readonly onSend: (answers: Record<string, string>) => void
  readonly onSkip: () => void
}

function OptionRow({ question, questionIndex, option, state, onToggle }: { readonly question: AskQuestion; readonly questionIndex: number; readonly option: AskQuestion['options'][number]; readonly state: QuestionsState; readonly onToggle: (label: string) => void }) {
  const checked = state[questionIndex]?.selected.has(option.label) ?? false
  const inputId = `question-${String(questionIndex)}-${option.label}`
  return (
    <label htmlFor={inputId} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
      <input id={inputId} type={question.multiSelect ? 'checkbox' : 'radio'} name={`question-${String(questionIndex)}`} checked={checked} onChange={() => onToggle(option.label)} className="mt-0.5" />
      <span className="flex flex-col">
        <span className="text-small text-foreground">{option.label}</span>
        {option.description !== null ? <span className="text-meta text-muted-foreground">{option.description}</span> : null}
      </span>
    </label>
  )
}

function QuestionSection({ question, questionIndex, state, onToggle, onOther }: { readonly question: AskQuestion; readonly questionIndex: number; readonly state: QuestionsState; readonly onToggle: (label: string) => void; readonly onOther: (value: string) => void }) {
  const other = state[questionIndex]?.other ?? ''
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-muted px-2 py-0.5 text-meta font-medium text-muted-foreground">{question.header}</span>
      </div>
      <p className="text-body text-foreground">{question.question}</p>
      <div className="flex flex-col">
        {question.options.map((option) => (
          <OptionRow key={option.label} question={question} questionIndex={questionIndex} option={option} state={state} onToggle={onToggle} />
        ))}
        <div className="flex items-center gap-2 px-2 py-1.5">
          <span className="text-small text-muted-foreground">{QUESTION_OTHER_LABEL}:</span>
          <Input value={other} onChange={(event) => onOther(event.target.value)} className="h-7 flex-1 text-small" />
        </div>
      </div>
    </div>
  )
}

export function QuestionCard({ questions, sending, error, onSend, onSkip }: QuestionCardProps) {
  const [state, setState] = useState<QuestionsState>(() => initialState(questions))
  const complete = isComplete(questions, state)

  return (
    <div data-slot="question-card" className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-attention-dot" />
        <h3 className="text-body font-semibold">{questionProgress(questions.length)}</h3>
      </div>
      <div className="flex flex-col gap-4">
        {questions.map((question, index) => (
          <QuestionSection
            key={question.question}
            question={question}
            questionIndex={index}
            state={state}
            onToggle={(label) => setState((prev) => toggleOption(prev, index, question.multiSelect, label))}
            onOther={(value) => setState((prev) => setOther(prev, index, value))}
          />
        ))}
      </div>
      {error !== null ? <p className="text-meta text-destructive">{questionAnswerFailed(error)}</p> : null}
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="small" disabled={sending} onClick={onSkip}>
          {QUESTION_SKIP}
        </Button>
        <Button size="small" disabled={!complete || sending} onClick={() => onSend(toAnswers(questions, state))}>
          {QUESTION_SEND}
        </Button>
      </div>
    </div>
  )
}
