// The plan gate dialog's own steps, split out to stay under 500 lines.
import { Button } from '@/components/ui/button'
import { DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Markdown } from '../components/markdown'
import type { ClaimRead } from '../../../shared/writes/types'
import type { RepoId } from '../../../shared/repos'
import type { GateState } from './controller'
import { backToReview, closeGateDialog, goToClaimStep, openFeedback, pickRepo, retryLabelOnly, retryPreflight, setClaim, setFeedbackText, submitApprove, submitFeedback, tryCommentAgain } from './controller'
import {
  assigneeNoteCopy,
  autoPlanNoteCopy,
  claimLineCopy,
  feedbackHint,
  isClaimHeldForPlanGate,
  noPlanNoteCopy,
  primaryApproveLabel,
  refusedVerdictCopy,
  resultCopy,
  sessionRequiredCopy,
} from './copy'

function Aside({ line, note }: { readonly line: string; readonly note: string | null }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md bg-muted px-3 py-2 text-small">
      <span>{line}</span>
      {note !== null && note !== '' ? <span className="text-meta text-muted-foreground">{note}</span> : null}
    </div>
  )
}

export function ClaimPickingStep({ state }: { readonly state: Extract<GateState, { readonly step: 'claim-picking' }> }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Plan gate</DialogTitle>
      </DialogHeader>
      {state.repos.length === 0 ? (
        <p className="text-small text-muted-foreground">No port-managed repositories yet.</p>
      ) : state.repos.length > 1 ? (
        <label className="flex flex-col gap-1">
          <span className="text-small text-muted-foreground">Repository</span>
          <Select value={state.repoId ?? undefined} onValueChange={(value) => pickRepo(value as RepoId)}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Pick a repository" />
            </SelectTrigger>
            <SelectContent>
              {state.repos.map((repo) => (
                <SelectItem key={repo.id} value={repo.id}>
                  {repo.repo}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      ) : null}
      <DialogFooter>
        <Button variant="outline" onClick={closeGateDialog}>
          Cancel
        </Button>
      </DialogFooter>
    </>
  )
}

export function ClaimStatusStep({ claim, acting }: { readonly claim: ClaimRead; readonly acting: boolean }) {
  const copy = claimLineCopy(claim)
  return (
    <>
      <DialogHeader>
        <DialogTitle>Plan gate</DialogTitle>
      </DialogHeader>
      <Aside line={copy.line} note={copy.note} />
      <DialogFooter>
        <Button variant="outline" onClick={closeGateDialog} disabled={acting}>
          Cancel
        </Button>
        {copy.action === 'take' ? (
          <Button onClick={() => setClaim(true)} disabled={acting}>
            Take the plan gate
          </Button>
        ) : null}
        {copy.action === 'release' ? (
          <Button onClick={() => setClaim(false)} disabled={acting}>
            Release the plan gate
          </Button>
        ) : null}
        {copy.action === 'overwrite' ? (
          <>
            <Button variant="outline" onClick={() => setClaim(false)} disabled={acting}>
              Delete the file
            </Button>
            <Button onClick={() => setClaim(true)} disabled={acting}>
              Overwrite with a fresh claim
            </Button>
          </>
        ) : null}
      </DialogFooter>
    </>
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

export function ReviewingStep({ state }: { readonly state: Extract<GateState, { readonly step: 'reviewing' }> }) {
  const { preflight, verdict, claim } = state
  const held = isClaimHeldForPlanGate(claim)
  const claimCopy = claimLineCopy(claim)

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
      {preflight.sessionRequired && preflight.sessionRequiredReason !== null ? (
        <div className="flex flex-col gap-1 rounded-md bg-attention-pill px-3 py-2 text-small text-attention-pill-foreground">
          <span className="font-medium">{sessionRequiredCopy(preflight.number, preflight.title, preflight.sessionRequiredReason).banner}</span>
          <span>{sessionRequiredCopy(preflight.number, preflight.title, preflight.sessionRequiredReason).note}</span>
          <code className="rounded bg-background/50 px-1.5 py-1 font-mono text-meta">{sessionRequiredCopy(preflight.number, preflight.title, preflight.sessionRequiredReason).launchLine}</code>
        </div>
      ) : null}
      {preflight.autoPlan ? <p className="text-small text-muted-foreground">{autoPlanNoteCopy(claim)}</p> : null}
      {verdict.assignedElsewhere.map((login) => (
        <p key={login} className="text-small text-muted-foreground">
          {assigneeNoteCopy(login)}
        </p>
      ))}
      {verdict.noPlanBlock ? <p className="text-small text-muted-foreground">{noPlanNoteCopy()}</p> : null}
      <Markdown source={preflight.planMarkdown ?? preflight.ticketMarkdown} className="max-h-[60vh] overflow-y-auto rounded-md border border-border p-3" />
      <Aside line={claimCopy.line} note={claimCopy.note} />
      {!held && claimCopy.action === 'take' ? (
        <Button variant="outline" size="small" onClick={() => setClaim(true)} className="self-start">
          Take the plan gate
        </Button>
      ) : null}
      <DialogFooter>
        <Button variant="outline" onClick={closeGateDialog}>
          Cancel
        </Button>
        <Button variant="outline" onClick={openFeedback} disabled={!held}>
          Request changes
        </Button>
        <Button onClick={submitApprove} disabled={!held}>
          {primaryApproveLabel(preflight.sessionRequired)}
        </Button>
      </DialogFooter>
    </>
  )
}

export function FeedbackStep({ state }: { readonly state: Extract<GateState, { readonly step: 'feedback' }> }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>What should change?</DialogTitle>
      </DialogHeader>
      <Textarea value={state.text} onChange={(event) => setFeedbackText(event.target.value)} rows={4} />
      <p className="text-meta text-muted-foreground">{feedbackHint(state.preflight.number)}</p>
      <DialogFooter>
        <Button variant="outline" onClick={closeGateDialog}>
          Cancel
        </Button>
        <Button variant="outline" onClick={backToReview}>
          Back
        </Button>
        <Button onClick={submitFeedback} disabled={state.text.trim() === ''}>
          Post and request changes
        </Button>
      </DialogFooter>
    </>
  )
}

export function RefusedStep({ number, verdict }: { readonly number: number; readonly verdict: Extract<GateState, { readonly step: 'refused' }>['verdict'] }) {
  const copy = refusedVerdictCopy(number, verdict)
  return (
    <>
      <DialogHeader>
        <DialogTitle>{copy.line}</DialogTitle>
      </DialogHeader>
      {copy.note !== null ? <p className="text-small text-muted-foreground">{copy.note}</p> : null}
      <DialogFooter>
        <Button variant="outline" onClick={retryPreflight}>
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

export function ResultStep({ state }: { readonly state: Extract<GateState, { readonly step: 'result' }> }) {
  const copy = resultCopy({ number: state.preflight.number, decision: state.decision, response: state.response, sessionRequired: state.preflight.sessionRequired })
  return (
    <>
      <DialogHeader>
        <DialogTitle>{copy.line}</DialogTitle>
      </DialogHeader>
      {copy.note !== null && copy.note !== '' ? <p className="text-small text-muted-foreground">{copy.note}</p> : null}
      <DialogFooter>
        {copy.actions.includes('retry-label') ? (
          <Button variant="outline" onClick={retryLabelOnly}>
            Retry the label change
          </Button>
        ) : null}
        {copy.actions.includes('show-state') ? (
          <Button variant="outline" onClick={retryPreflight}>
            Show me the current state
          </Button>
        ) : null}
        {copy.actions.includes('try-again') ? (
          <Button variant="outline" onClick={tryCommentAgain}>
            Try again
          </Button>
        ) : null}
        {copy.actions.includes('take-claim') ? (
          <Button variant="outline" onClick={goToClaimStep}>
            Take the plan gate
          </Button>
        ) : null}
        <Button onClick={closeGateDialog}>Dismiss</Button>
      </DialogFooter>
    </>
  )
}
