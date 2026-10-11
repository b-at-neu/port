// The end-of-session panel below the conversation — title, body, the SDK's
// own message, a runtime diagnosis when there is one, and New session.
import { Button } from '@/components/ui/button'
import { RUNTIME_COPY } from '../../../shared/runtime/copy'
import type { SessionEnd } from '../../../shared/hosting/types'
import { endBody, END_COPY, NEW_SESSION_BUTTON } from './copy'

export function EndPanel({ end, onNewSession }: { readonly end: SessionEnd; readonly onNewSession: () => void }) {
  const copy = END_COPY[end.reason]
  const diagnosisCopy = end.diagnosis !== null ? RUNTIME_COPY[end.diagnosis] : null

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
      <h2 className="text-title font-semibold">{copy.title}</h2>
      <p className="text-small text-muted-foreground">{endBody(end)}</p>
      {end.message !== null ? <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-meta whitespace-pre-wrap">{end.message}</pre> : null}
      {diagnosisCopy !== null ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-small font-medium">{diagnosisCopy.title}</h3>
          <p className="text-small text-muted-foreground">{diagnosisCopy.body}</p>
        </div>
      ) : null}
      <Button size="small" className="self-start" onClick={onNewSession}>
        {NEW_SESSION_BUTTON}
      </Button>
    </div>
  )
}
