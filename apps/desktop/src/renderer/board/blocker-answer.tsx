// The inline answer card for a blocked stage session: the operator's reply goes into that live session, which clears its own block.
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/renderer/components/ui/button'
import { Textarea } from '@/renderer/components/ui/textarea'
import { send } from '@/renderer/session/actions'
import { blockerSendError, blockerSentToast } from '@/renderer/board/blocked-copy'
import type { SessionKey } from '@/types/hosting'

interface BlockerAnswerProps {
  readonly sessionKey: SessionKey
  readonly number: number | null
}

export function BlockerAnswer({ sessionKey, number }: BlockerAnswerProps) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(): Promise<void> {
    setSending(true)
    setError(null)
    const outcome = await send(sessionKey, text)
    setSending(false)
    if (outcome.ok) {
      toast(blockerSentToast(number))
      setText('')
      return
    }
    setError(blockerSendError(outcome.error === 'blocked-command' || outcome.error === 'unreachable' ? outcome.error : 'unknown-session', number))
  }

  return (
    <div data-slot="blocker-answer" className="flex flex-col gap-2">
      <label htmlFor={`blocker-answer-${sessionKey}`} className="text-small text-foreground">
        Your answer
      </label>
      <Textarea id={`blocker-answer-${sessionKey}`} value={text} onChange={(event) => setText(event.target.value)} disabled={sending} />
      {error !== null ? <p className="text-meta text-destructive">{error}</p> : null}
      <div className="flex justify-end">
        <Button size="small" disabled={text.trim() === '' || sending} onClick={() => void submit()}>
          Send to agent
        </Button>
      </div>
    </div>
  )
}
