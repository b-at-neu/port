// The claim dialog (#93, #319) — a shadcn `Dialog` over `claim/controller.ts`'s
// `useSyncExternalStore` state, in place of the deleted `view.ts`'s native
// `<dialog>`. Closing via Esc or the scrim calls `closeClaimDialog`, the
// same as every button that used to carry the `claim-cancel` action.
import { useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { ClaimVerdict, PlanGateChoice } from '../../../shared/claim/types'
import type { RepoId } from '../../../shared/repos'
import { backToPick, closeClaimDialog, confirmClaim, getState, retryPreflight, setClaimNumber, setClaimRepo, setPlanGate, submitPick, subscribe } from './controller'
import { PLAN_GATE_OPTIONS, assigneeCopy, blockersCopy, closedCopy, movedCopy, preflightFailedCopy, primaryButtonLabel, refusalCopy, writeOutcomeCopy } from './copy'

function Aside({ line, note }: { readonly line: string; readonly note: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md bg-muted px-3 py-2 text-small">
      <span>{line}</span>
      {note !== '' ? <span className="text-meta text-muted-foreground">{note}</span> : null}
    </div>
  )
}

function PickStep() {
  const state = useSyncExternalStore(subscribe, getState)
  if (state.step !== 'picking') return null

  if (state.repos.length === 0) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Work on…</DialogTitle>
        </DialogHeader>
        <p className="text-small text-muted-foreground">No port-managed repositories yet. Add one on the Repositories tab.</p>
        <DialogFooter>
          <Button variant="outline" onClick={closeClaimDialog}>
            Cancel
          </Button>
        </DialogFooter>
      </>
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Work on…</DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-small text-muted-foreground">Repository</span>
          <Select value={state.repoId ?? undefined} onValueChange={(value) => setClaimRepo(value as RepoId)}>
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
        <label className="flex flex-col gap-1">
          <span className="text-small text-muted-foreground">Issue number</span>
          <Input inputMode="numeric" value={state.number} onChange={(event) => setClaimNumber(event.target.value)} />
        </label>
        <p className="text-meta text-muted-foreground">Opt-in labels the issue and assigns it to you. It does not dispatch — a cockpit assigned to you picks it up on its next tick.</p>
        {state.error !== null ? <p className="text-small text-danger-dot">{state.error}</p> : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={closeClaimDialog}>
          Cancel
        </Button>
        <Button onClick={submitPick} disabled={state.number.trim() === ''}>
          Continue
        </Button>
      </DialogFooter>
    </>
  )
}

function LoadingStep({ repo, number }: { readonly repo: string; readonly number: number }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Work on…</DialogTitle>
      </DialogHeader>
      <p className="text-small text-muted-foreground">Reading #{number} from {repo}…</p>
    </>
  )
}

function ReviewStep() {
  const state = useSyncExternalStore(subscribe, getState)
  if (state.step !== 'reviewing') return null
  const { preflight, verdict } = state
  const claimable = verdict as Extract<ClaimVerdict, { kind: 'claimable' }>
  const blockers = blockersCopy(claimable)
  const assignee = assigneeCopy(claimable)

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          #{preflight.number} · {preflight.title}
        </DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-2">
        {blockers !== null ? <Aside line={blockers.line} note={blockers.note} /> : null}
        {assignee !== null ? <Aside line={assignee.line} note={assignee.note} /> : null}
        {claimable.closed ? <Aside line={closedCopy(preflight.number).line} note={closedCopy(preflight.number).note} /> : null}
        <label className="flex flex-col gap-1">
          <span className="text-small text-muted-foreground">Plan gate</span>
          <Select value={state.planGate} onValueChange={(value) => setPlanGate(value as PlanGateChoice)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLAN_GATE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  <div className="flex flex-col">
                    <span>{option.label}</span>
                    <span className="text-meta text-muted-foreground">{option.hint}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={closeClaimDialog}>
          Cancel
        </Button>
        <Button variant="outline" onClick={backToPick}>
          Back
        </Button>
        <Button onClick={confirmClaim}>{primaryButtonLabel(claimable)}</Button>
      </DialogFooter>
    </>
  )
}

function RefusalStep({ line, note, url, showRetry, retryLabel }: { readonly line: string; readonly note: string | null; readonly url: string | null; readonly showRetry: boolean; readonly retryLabel: string }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>{line}</DialogTitle>
      </DialogHeader>
      {note !== null && note !== '' ? <p className="text-small text-muted-foreground">{note}</p> : null}
      <DialogFooter>
        {url !== null ? (
          <Button variant="outline" asChild>
            <a href={url} target="_blank" rel="noreferrer">
              Open on GitHub
            </a>
          </Button>
        ) : null}
        {showRetry ? (
          <Button variant="outline" onClick={retryPreflight}>
            {retryLabel}
          </Button>
        ) : null}
        <Button onClick={closeClaimDialog}>{showRetry || url !== null ? 'Dismiss' : 'Close'}</Button>
      </DialogFooter>
    </>
  )
}

function DialogBody() {
  const state = useSyncExternalStore(subscribe, getState)
  switch (state.step) {
    case 'closed':
      return null
    case 'picking':
      return <PickStep />
    case 'loading':
      return <LoadingStep repo={state.repo} number={state.number} />
    case 'reviewing':
      return <ReviewStep />
    case 'refused': {
      const copy = refusalCopy(state.repo, state.number, state.verdict)
      return <RefusalStep line={copy.line} note={copy.note} url={state.url} showRetry={false} retryLabel="" />
    }
    case 'preflight-failed': {
      const copy = preflightFailedCopy(state.message)
      return <RefusalStep line={copy.line} note={copy.note} url={null} showRetry={false} retryLabel="" />
    }
    case 'applying':
      return (
        <>
          <DialogHeader>
            <DialogTitle>Work on…</DialogTitle>
          </DialogHeader>
          <p className="text-small text-muted-foreground">Claiming #{state.number}…</p>
        </>
      )
    case 'moved': {
      const copy = movedCopy(state.current, state.readAt)
      return <RefusalStep line={copy.line} note={copy.note} url={null} showRetry retryLabel="Show me the current state" />
    }
    case 'refused-at-apply': {
      const copy = refusalCopy(state.repo, state.number, state.verdict)
      return <RefusalStep line={copy.line} note={copy.note} url={null} showRetry={false} retryLabel="" />
    }
    case 'write-result': {
      const copy = writeOutcomeCopy(state.number, state.outcome)
      return <RefusalStep line={copy.line} note={copy.note} url={null} showRetry={state.outcome.kind === 'precondition-failed'} retryLabel="Show me the current state" />
    }
  }
}

export function ClaimDialog() {
  const state = useSyncExternalStore(subscribe, getState)
  const open = state.step !== 'closed'

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeClaimDialog()}>
      {open ? (
        <DialogContent>
          <DialogBody />
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
