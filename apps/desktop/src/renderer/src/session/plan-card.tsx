// The ExitPlanMode card: the plan as markdown, a feedback textarea, and the operator's three decisions.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Markdown } from '../components/markdown'
import { PLAN_APPROVE_ACCEPT_EDITS, PLAN_APPROVE_ASK, PLAN_EMPTY, PLAN_FEEDBACK_PLACEHOLDER, PLAN_HEADING, PLAN_KEEP_PLANNING, PLAN_SENDING, planAnswerFailed } from './interaction-copy'

export interface PlanCardProps {
  readonly plan: string | null
  readonly sending: boolean
  readonly error: string | null
  readonly onApprove: (mode: 'default' | 'acceptEdits') => void
  readonly onKeepPlanning: (feedback: string) => void
}

export function PlanCard({ plan, sending, error, onApprove, onKeepPlanning }: PlanCardProps) {
  const [feedback, setFeedback] = useState('')

  return (
    <div data-slot="plan-card" className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-attention-dot" />
        <h3 className="text-body font-semibold">{PLAN_HEADING}</h3>
      </div>
      <div className="max-h-[60vh] overflow-y-auto rounded-md bg-muted p-3">{plan !== null && plan !== '' ? <Markdown source={plan} /> : <p className="text-small text-muted-foreground">{PLAN_EMPTY}</p>}</div>
      <Textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder={PLAN_FEEDBACK_PLACEHOLDER} disabled={sending} rows={2} className="resize-none" />
      {error !== null ? <p className="text-meta text-destructive">{planAnswerFailed(error)}</p> : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" size="small" disabled={feedback.trim() === '' || sending} onClick={() => onKeepPlanning(feedback.trim())}>
          {sending ? PLAN_SENDING : PLAN_KEEP_PLANNING}
        </Button>
        <Button variant="outline" size="small" disabled={sending} onClick={() => onApprove('default')}>
          {PLAN_APPROVE_ASK}
        </Button>
        <Button size="small" disabled={sending} onClick={() => onApprove('acceptEdits')}>
          {PLAN_APPROVE_ACCEPT_EDITS}
        </Button>
      </div>
    </div>
  )
}
