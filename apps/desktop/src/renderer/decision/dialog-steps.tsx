import { useState } from 'react'
import { pickList, picksProblem, reviseNoteProblem } from '@/utils/actions/decide'
import { Button } from '@/renderer/components/ui/button'
import { DialogFooter, DialogHeader, DialogTitle } from '@/renderer/components/ui/dialog'
import { Textarea } from '@/renderer/components/ui/textarea'
import { useDecideItem } from '@/renderer/actions/decide-item'
import type { RebaseDecision, UnblockRoute } from '@/types/actions'
import type { DecisionTarget } from '@/types/decision'
import { closeDecisionDialog } from '@/renderer/decision/controller'
import { dialogTitle, picksHint, rebaseLegend, rebaseOptionLabel, reviseConsequence, reviseNoteHint, unblockCapNote, unblockConsequence, unblockReasonLine } from '@/renderer/decision/copy'

type Picks = Readonly<Record<string, string>>

function RebaseDecisionFields({ decisions, picks, onPick }: { readonly decisions: readonly RebaseDecision[]; readonly picks: Picks; readonly onPick: (id: string, letter: string) => void }) {
  if (decisions.length === 0) return null
  return (
    <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto p-1">
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
                onChange={() => onPick(decision.id, option.letter)}
                className="size-4 shrink-0 accent-primary outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <span>{rebaseOptionLabel(option)}</span>
              {decision.recommended === option.letter ? <span className="text-meta text-muted-foreground">Recommended</span> : null}
            </label>
          ))}
        </fieldset>
      ))}
    </div>
  )
}

export function ConfirmUnblockStep({ target }: { readonly target: Extract<DecisionTarget, { readonly decision: 'unblock' }> }) {
  const { repoId, number, expectedStage, context } = target
  const { decisions } = context
  const [picks, setPicks] = useState<Picks>(() => Object.fromEntries(decisions.flatMap((d) => (d.recommended === null ? [] : [[d.id, d.recommended]]))))
  const decide = useDecideItem({})
  const capNote = unblockCapNote(context)
  const hint = picksHint(decisions, picks)
  const picksInvalid = decisions.length > 0 && picksProblem(decisions, pickList(decisions, picks)) !== null

  function submit(route: UnblockRoute): void {
    const chosen = decisions.length === 0 ? null : pickList(decisions, picks)
    if (chosen !== null && picksProblem(decisions, chosen) !== null) return
    closeDecisionDialog()
    void decide.perform({ repoId, number, expectedStage, decision: 'unblock', route, note: null, skipComment: false, picks: chosen })
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{dialogTitle('unblock', number, context.target)}</DialogTitle>
      </DialogHeader>
      <p className="text-small text-muted-foreground">{unblockReasonLine(context)}</p>
      <RebaseDecisionFields decisions={decisions} picks={picks} onPick={(id, letter) => setPicks((current) => ({ ...current, [id]: letter }))} />
      <p className="text-small text-muted-foreground">{unblockConsequence(context)}</p>
      {capNote !== null ? <p className="text-small text-attention-pill-foreground">{capNote}</p> : null}
      {hint !== null ? <p className="text-meta text-muted-foreground">{hint}</p> : null}
      <DialogFooter>
        <Button variant="outline" onClick={closeDecisionDialog}>
          Cancel
        </Button>
        {context.target === 'issue' ? (
          <Button onClick={() => submit('implementation')}>Send back to implementation</Button>
        ) : (
          <>
            {context.routes.includes('review') ? (
              <Button variant="outline" onClick={() => submit('review')}>
                Send to review
              </Button>
            ) : null}
            <Button onClick={() => submit('revision')} disabled={picksInvalid}>
              Send to revision
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  )
}

export function ConfirmReviseStep({ target }: { readonly target: Extract<DecisionTarget, { readonly decision: 'revise' }> }) {
  const { repoId, number, expectedStage, context } = target
  const [text, setText] = useState('')
  const decide = useDecideItem({})
  const problem = reviseNoteProblem(text, context.headRefOid)
  const hint = reviseNoteHint(problem)

  function submit(): void {
    if (problem !== null) return
    closeDecisionDialog()
    void decide.perform({ repoId, number, expectedStage, decision: 'revise', route: null, note: text, skipComment: false, picks: null })
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{dialogTitle('revise', number)}</DialogTitle>
      </DialogHeader>
      <p className="text-small text-muted-foreground">{reviseConsequence(context)}</p>
      <label className="flex flex-col gap-1">
        <span className="text-small text-muted-foreground">What should change?</span>
        <Textarea value={text} onChange={(event) => setText(event.target.value)} rows={4} />
      </label>
      {hint !== null ? <p className="text-meta text-muted-foreground">{hint}</p> : null}
      <DialogFooter>
        <Button variant="outline" onClick={closeDecisionDialog}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={problem !== null}>
          Send back to revision
        </Button>
      </DialogFooter>
    </>
  )
}
