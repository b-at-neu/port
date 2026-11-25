import { Dialog, DialogContent } from '@/renderer/components/ui/dialog'
import { ConfirmDialog } from '@/renderer/components/confirm-dialog'
import { useDecideItem } from '@/renderer/actions/decide-item'
import { DECISION_BUTTON_LABELS } from '@/renderer/board/copy'
import { closeDecisionDialog, useDecisionTarget } from '@/renderer/decision/controller'
import { dialogTitle, grantConsequence } from '@/renderer/decision/copy'
import { ConfirmReviseStep, ConfirmUnblockStep } from '@/renderer/decision/dialog-steps'
import type { DecisionTarget } from '@/types/decision'

type GrantTarget = Extract<DecisionTarget, { readonly decision: 'grant' }>

function GrantConfirm({ target }: { readonly target: GrantTarget }) {
  const { repoId, number, expectedStage, context } = target
  const decide = useDecideItem({ cap: context.cap })

  function confirm(): void {
    closeDecisionDialog()
    void decide.perform({ repoId, number, expectedStage, decision: 'grant', route: null, note: null, skipComment: false, picks: null })
  }

  return <ConfirmDialog open title={dialogTitle('grant', number)} description={grantConsequence(context, number)} confirmLabel={DECISION_BUTTON_LABELS.grant} onCancel={closeDecisionDialog} onConfirm={confirm} />
}

function DecisionForm({ target }: { readonly target: Exclude<DecisionTarget, { readonly decision: 'grant' }> }) {
  const key = `${target.repoId}:${String(target.number)}`
  return target.decision === 'unblock' ? <ConfirmUnblockStep key={key} target={target} /> : <ConfirmReviseStep key={key} target={target} />
}

export function DecisionDialog() {
  const target = useDecisionTarget()

  if (target?.decision === 'grant') return <GrantConfirm target={target} />

  return (
    <Dialog open={target !== null} onOpenChange={(next) => !next && closeDecisionDialog()}>
      {target !== null ? (
        <DialogContent className="max-w-xl">
          <DecisionForm target={target} />
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
