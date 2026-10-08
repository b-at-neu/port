// The decision dialog's own steps, the same split gate/dialog-steps.tsx uses.
import { reviseNoteProblem } from '../../../shared/actions/decide'
import { Button } from '@/components/ui/button'
import { DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import type { DecisionState } from './controller'
import { closeDecisionDialog, retryLabelOnly, setReviseText, submitRevise, submitUnblock } from './controller'
import { decisionResultCopy, dialogTitle, reviseConsequence, reviseNoteHint, unblockCapNote, unblockConsequence, unblockReasonLine } from './copy'

export function ConfirmUnblockStep({ state }: { readonly state: Extract<DecisionState, { readonly step: 'confirm-unblock' }> }) {
  const capNote = unblockCapNote(state.context)
  return (
    <>
      <DialogHeader>
        <DialogTitle>{dialogTitle('unblock', state.number)}</DialogTitle>
      </DialogHeader>
      <p className="text-small text-muted-foreground">{unblockReasonLine(state.context)}</p>
      <p className="text-small text-muted-foreground">{unblockConsequence()}</p>
      {capNote !== null ? <p className="text-small text-attention-pill-foreground">{capNote}</p> : null}
      <DialogFooter>
        <Button variant="outline" onClick={closeDecisionDialog}>
          Cancel
        </Button>
        <Button variant="outline" onClick={() => submitUnblock('review')}>
          Send to review
        </Button>
        <Button onClick={() => submitUnblock('revision')}>Send to revision</Button>
      </DialogFooter>
    </>
  )
}

export function ConfirmReviseStep({ state }: { readonly state: Extract<DecisionState, { readonly step: 'confirm-revise' }> }) {
  const problem = reviseNoteProblem(state.text, state.context.headRefOid)
  const hint = reviseNoteHint(problem)
  return (
    <>
      <DialogHeader>
        <DialogTitle>{dialogTitle('revise', state.number)}</DialogTitle>
      </DialogHeader>
      <p className="text-small text-muted-foreground">{reviseConsequence(state.context)}</p>
      <label className="flex flex-col gap-1">
        <span className="text-small text-muted-foreground">What should change?</span>
        <Textarea value={state.text} onChange={(event) => setReviseText(event.target.value)} rows={4} />
      </label>
      {hint !== null ? <p className="text-meta text-muted-foreground">{hint}</p> : null}
      <DialogFooter>
        <Button variant="outline" onClick={closeDecisionDialog}>
          Cancel
        </Button>
        <Button onClick={submitRevise} disabled={problem !== null}>
          Send back to revision
        </Button>
      </DialogFooter>
    </>
  )
}

export function ApplyingStep({ decision }: { readonly decision: 'unblock' | 'revise' }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>{decision === 'unblock' ? 'Unblocking…' : 'Sending back…'}</DialogTitle>
      </DialogHeader>
    </>
  )
}

export function ResultStep({ state }: { readonly state: Extract<DecisionState, { readonly step: 'result' }> }) {
  const copy = decisionResultCopy({ number: state.number, decision: state.decision, route: state.route, response: state.response })
  return (
    <>
      <DialogHeader>
        <DialogTitle>{copy.line}</DialogTitle>
      </DialogHeader>
      {copy.note !== null ? <p className="text-small text-muted-foreground">{copy.note}</p> : null}
      <DialogFooter>
        {copy.offerLabelOnly ? (
          <Button variant="outline" onClick={retryLabelOnly}>
            Swap labels only
          </Button>
        ) : null}
        <Button onClick={closeDecisionDialog}>Dismiss</Button>
      </DialogFooter>
    </>
  )
}
