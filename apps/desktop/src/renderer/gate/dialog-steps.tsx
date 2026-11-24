import { Button } from '@/renderer/components/ui/button'
import { DialogFooter, DialogHeader, DialogTitle } from '@/renderer/components/ui/dialog'
import { Textarea } from '@/renderer/components/ui/textarea'
import { Markdown } from '@/renderer/components/markdown'
import type { GatePreflight, GateVerdict } from '@/types/gate'
import type { OwnershipSummary } from '@/types/writes'
import { closeGateDialog } from '@/renderer/gate/controller'
import { assigneeNoteCopy, autoPlanNoteCopy, feedbackHint, gateDisabledReason, noPlanNoteCopy, primaryApproveLabel, refusedVerdictCopy, sessionRequiredCopy } from '@/renderer/gate/copy'

function Aside({ line, note }: { readonly line: string; readonly note: string | null }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md bg-muted px-3 py-2 text-small">
      <span>{line}</span>
      {note !== null && note !== '' ? <span className="text-meta text-muted-foreground">{note}</span> : null}
    </div>
  )
}

export function LoadingStep({ hint }: { readonly hint: string }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Plan gate</DialogTitle>
      </DialogHeader>
      <p className="text-small text-muted-foreground">{hint}</p>
    </>
  )
}

interface ReviewingProps {
  readonly preflight: GatePreflight
  readonly verdict: Extract<GateVerdict, { readonly kind: 'answerable' }>
  readonly ownership: OwnershipSummary
  readonly onCancel: () => void
  readonly onRequestChanges: () => void
  readonly onApprove: () => void
}

export function ReviewingStep({ preflight, verdict, ownership, onCancel, onRequestChanges, onApprove }: ReviewingProps) {
  const disabledReason = gateDisabledReason(ownership)
  const required = preflight.sessionRequired && preflight.sessionRequiredReason !== null ? sessionRequiredCopy(preflight.number, preflight.title, preflight.sessionRequiredReason, ownership) : null

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          #{preflight.number} · {preflight.title}
        </DialogTitle>
      </DialogHeader>
      <a href={preflight.url} target="_blank" rel="noreferrer" className="text-small text-primary-text hover:underline">
        Open on GitHub
      </a>
      {required !== null ? (
        <div className="flex flex-col gap-1 rounded-md bg-attention-pill px-3 py-2 text-small text-attention-pill-foreground">
          <span className="font-medium">{required.banner}</span>
          <span>{required.note}</span>
          {required.launchLine !== null ? <code className="rounded bg-background/50 px-1.5 py-1 font-mono text-meta">{required.launchLine}</code> : null}
        </div>
      ) : null}
      {preflight.autoPlan ? <p className="text-small text-muted-foreground">{autoPlanNoteCopy(ownership)}</p> : null}
      {verdict.assignedElsewhere.map((login) => (
        <p key={login} className="text-small text-muted-foreground">
          {assigneeNoteCopy(login)}
        </p>
      ))}
      {verdict.noPlanBlock ? <p className="text-small text-muted-foreground">{noPlanNoteCopy()}</p> : null}
      <Markdown source={preflight.planMarkdown ?? preflight.ticketMarkdown} className="max-h-[60vh] overflow-y-auto rounded-md border border-border p-3" />
      {disabledReason !== null ? <Aside line={disabledReason} note={null} /> : null}
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="outline" onClick={onRequestChanges} disabled={disabledReason !== null}>
          Request changes
        </Button>
        <Button onClick={onApprove} disabled={disabledReason !== null}>
          {primaryApproveLabel(preflight.sessionRequired, ownership)}
        </Button>
      </DialogFooter>
    </>
  )
}

interface FeedbackProps {
  readonly number: number
  readonly text: string
  readonly onTextChange: (text: string) => void
  readonly onCancel: () => void
  readonly onBack: () => void
  readonly onSubmit: () => void
}

export function FeedbackStep({ number, text, onTextChange, onCancel, onBack, onSubmit }: FeedbackProps) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>What should change?</DialogTitle>
      </DialogHeader>
      <Textarea value={text} onChange={(event) => onTextChange(event.target.value)} rows={4} />
      <p className="text-meta text-muted-foreground">{feedbackHint(number)}</p>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onSubmit} disabled={text.trim() === ''}>
          Post and request changes
        </Button>
      </DialogFooter>
    </>
  )
}

export function RefusedStep({ number, verdict, onRetry }: { readonly number: number; readonly verdict: Exclude<GateVerdict, { readonly kind: 'answerable' }>; readonly onRetry: () => void }) {
  const copy = refusedVerdictCopy(number, verdict)
  return (
    <>
      <DialogHeader>
        <DialogTitle>{copy.line}</DialogTitle>
      </DialogHeader>
      {copy.note !== null ? <p className="text-small text-muted-foreground">{copy.note}</p> : null}
      <DialogFooter>
        <Button variant="outline" onClick={onRetry}>
          Show me the current state
        </Button>
        <Button onClick={closeGateDialog}>Dismiss</Button>
      </DialogFooter>
    </>
  )
}

export function ErrorStep({ line, note }: { readonly line: string; readonly note: string }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>{line}</DialogTitle>
      </DialogHeader>
      <p className="text-small text-muted-foreground">{note}</p>
      <DialogFooter>
        <Button onClick={closeGateDialog}>Dismiss</Button>
      </DialogFooter>
    </>
  )
}
