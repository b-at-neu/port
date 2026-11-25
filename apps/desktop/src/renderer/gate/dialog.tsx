import { useState } from 'react'
import { Dialog, DialogContent } from '@/renderer/components/ui/dialog'
import { useIpcQuery } from '@/renderer/data/query'
import { useAnswerGate } from '@/renderer/actions/answer-gate'
import { closeGateDialog, useGateTarget } from '@/renderer/gate/controller'
import type { GateTarget } from '@/renderer/gate/controller'
import { gateStepOf } from '@/renderer/gate/model'
import type { GateStep } from '@/renderer/gate/model'
import { ErrorStep, FeedbackStep, LoadingStep, RefusedStep, ReviewingStep } from '@/renderer/gate/dialog-steps'

type Reviewing = Extract<GateStep, { readonly kind: 'reviewing' }>

function GateReview({ target, step }: { readonly target: GateTarget; readonly step: Reviewing }) {
  const { preflight, verdict, ownership } = step
  const [mode, setMode] = useState<'review' | 'feedback'>('review')
  const [text, setText] = useState('')
  const answer = useAnswerGate({ repoId: target.repoId, preflight, ownership })
  const { repoId, number } = target

  function approve(): void {
    closeGateDialog()
    void answer.perform({ repoId, number, decision: 'approve', feedback: null, skipComment: false })
  }

  function submitFeedback(): void {
    if (text.trim() === '') return
    closeGateDialog()
    void answer.perform({ repoId, number, decision: 'request-changes', feedback: text, skipComment: false })
  }

  if (mode === 'feedback') {
    return <FeedbackStep number={preflight.number} text={text} onTextChange={setText} onCancel={closeGateDialog} onBack={() => setMode('review')} onSubmit={submitFeedback} />
  }
  return <ReviewingStep preflight={preflight} verdict={verdict} ownership={ownership} onCancel={closeGateDialog} onRequestChanges={() => setMode('feedback')} onApprove={approve} />
}

function GateBody({ target, step, onRetry }: { readonly target: GateTarget; readonly step: GateStep; readonly onRetry: () => void }) {
  switch (step.kind) {
    case 'loading':
      return <LoadingStep hint={`Reading #${String(target.number)}…`} />
    case 'failed':
      return <ErrorStep line="Couldn't reach GitHub." note={step.message} />
    case 'refused':
      return <RefusedStep number={target.number} verdict={step.verdict} onRetry={onRetry} />
    case 'reviewing':
      return <GateReview key={`${target.repoId}:${String(target.number)}`} target={target} step={step} />
  }
}

export function GateDialog() {
  const target = useGateTarget()
  const preflight = useIpcQuery('gate.preflight', target ?? undefined, { enabled: target !== null })

  return (
    <Dialog open={target !== null} onOpenChange={(next) => !next && closeGateDialog()}>
      {target !== null ? (
        <DialogContent className="max-w-xl">
          <GateBody target={target} step={gateStepOf(preflight)} onRetry={() => void preflight.refetch()} />
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
