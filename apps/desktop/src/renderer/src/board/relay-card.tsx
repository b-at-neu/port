// The Board's own relay card (#319, plan's own **UX states**) — the same
// compose-and-copy shape as `needs-you/relay-form.tsx`'s `RelayForm`, kept
// as its own component rather than shared: the Board's copy button reads
// "Copy reply" (not "Copy answers"/"Copy decision") and toasts on success,
// which the Needs-you screen's own card does not.
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { composeReply } from '../../../shared/relay/compose'
import type { RelayPending } from '../../../shared/relay/types'

export interface RelayCardProps {
  readonly pending: RelayPending
}

function answerCountFor(pending: RelayPending): number {
  return pending.kind === 'questions' ? pending.questions.length : 1
}

export function RelayCard({ pending }: RelayCardProps) {
  const [answers, setAnswers] = useState<string[]>(() => new Array<string>(answerCountFor(pending)).fill(''))
  const [copied, setCopied] = useState(false)

  if (pending.kind === 'usage-limit') return null

  function setAnswer(index: number, value: string): void {
    setAnswers((current) => {
      const next = current.slice()
      next[index] = value
      return next
    })
    setCopied(false)
  }

  const composed = composeReply(pending, answers)

  async function handleCopy(): Promise<void> {
    if (composed === null) return
    try {
      const result = await window.port.relayCopy({ text: composed })
      if (result.ok) {
        setCopied(true)
        toast("Reply copied. Paste it into the agent's session.")
        setTimeout(() => setCopied(false), 1500)
      }
    } catch (error) {
      console.error('Failed to copy the relay reply', error)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      {pending.kind === 'questions' ? (
        pending.questions.map((question, index) => (
          <div key={question.index} className="flex flex-col gap-1">
            <p className="text-small text-foreground">
              {index + 1}. {question.text}
            </p>
            <Textarea value={answers[index] ?? ''} onChange={(event) => setAnswer(index, event.target.value)} rows={2} />
          </div>
        ))
      ) : (
        <div className="flex flex-col gap-1">
          <p className="text-small text-foreground">{pending.request}</p>
          <p className="text-meta text-muted-foreground">Your decision</p>
          <Textarea value={answers[0] ?? ''} onChange={(event) => setAnswer(0, event.target.value)} rows={2} />
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="small" onClick={() => void handleCopy()} disabled={composed === null}>
          {copied ? 'Copied' : 'Copy reply'}
        </Button>
        {composed === null && pending.kind === 'questions' ? <span className="text-meta text-muted-foreground">Answer all {answerCountFor(pending)} to copy.</span> : null}
      </div>
    </div>
  )
}
