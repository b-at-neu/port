// The decision dialog's own steps, the same split gate/dialog-steps.tsx uses.
import { pickList, picksProblem, reviseNoteProblem } from '@/utils/actions/decide'
import { Button } from '@/renderer/components/ui/button'
import { DialogFooter, DialogHeader, DialogTitle } from '@/renderer/components/ui/dialog'
import { Textarea } from '@/renderer/components/ui/textarea'
import type { RebaseDecision } from '@/types/actions'
import type { DecisionState } from '@/types/decision'
import { closeDecisionDialog, retryLabelOnly, setPick, setReviseText, submitRevise, submitUnblock } from '@/renderer/decision/controller'
import { decisionResultCopy, dialogTitle, picksHint, rebaseLegend, rebaseOptionLabel, reviseConsequence, reviseNoteHint, unblockCapNote, unblockConsequence, unblockReasonLine } from '@/renderer/decision/copy'

function RebaseDecisionFields({ decisions, picks }: { readonly decisions: readonly RebaseDecision[]; readonly picks: Readonly<Record<string, string>> }) {
  return (
    <>
      {decisions.map((decision) => (
        <fieldset key={decision.id} className="flex flex-col gap-1.5">
          <legend className="text-small font-medium">{rebaseLegend(decision)}</legend>
          {decision.summary !== null ? <p className="text-small text-muted-foreground">{decision.summary}</p> : null}
          {decision.options.map((option) => (
            <label key={option.letter} className="flex items-center gap-2 text-small">
              <input
                type="radio"
                name={decision.id}
                value={option.letter}
                checked={picks[decision.id] === option.letter}
                onChange={() => setPick(decision.id, option.letter)}
                className="size-4 shrink-0 accent-primary outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <span>{rebaseOptionLabel(option)}</span>
              {decision.recommended === option.letter ? <span className="text-meta text-muted-foreground">Recommended</span> : null}
            </label>
          ))}
        </fieldset>
      ))}
    </>
  )
}

export function ConfirmUnblockStep({ state }: { readonly state: Extract<DecisionState, { readonly step: 'confirm-unblock' }> }) {
  const capNote = unblockCapNote(state.context)
  const { decisions } = state.context
  const hint = picksHint(decisions, state.picks)
  const picksInvalid = decisions.length > 0 && picksProblem(decisions, pickList(decisions, state.picks)) !== null
  return (
    <>
      <DialogHeader>
        <DialogTitle>{dialogTitle('unblock', state.number)}</DialogTitle>
      </DialogHeader>
      <p className="text-small text-muted-foreground">{unblockReasonLine(state.context)}</p>
      <RebaseDecisionFields decisions={decisions} picks={state.picks} />
      <p className="text-small text-muted-foreground">{unblockConsequence(state.context)}</p>
      {capNote !== null ? <p className="text-small text-attention-pill-foreground">{capNote}</p> : null}
      {hint !== null ? <p className="text-meta text-muted-foreground">{hint}</p> : null}
      <DialogFooter>
        <Button variant="outline" onClick={closeDecisionDialog}>
          Cancel
        </Button>
        {decisions.length === 0 ? (
          <Button variant="outline" onClick={() => submitUnblock('review')}>
            Send to review
          </Button>
        ) : null}
        <Button onClick={() => submitUnblock('revision')} disabled={picksInvalid}>
          Send to revision
        </Button>
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
  const copy = decisionResultCopy({ number: state.number, decision: state.decision, route: state.route, picks: state.picks, response: state.response })
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
