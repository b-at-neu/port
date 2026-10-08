// The decision dialog — a shadcn Dialog over decision/controller.ts's
// useSyncExternalStore state, the same shape gate/dialog.tsx establishes.
import { useSyncExternalStore } from 'react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { closeDecisionDialog, getState, subscribe } from './controller'
import { ApplyingStep, ConfirmReviseStep, ConfirmUnblockStep, ResultStep } from './dialog-steps'

function DialogBody() {
  const state = useSyncExternalStore(subscribe, getState)
  switch (state.step) {
    case 'closed':
      return null
    case 'confirm-unblock':
      return <ConfirmUnblockStep state={state} />
    case 'confirm-revise':
      return <ConfirmReviseStep state={state} />
    case 'applying':
      return <ApplyingStep decision={state.decision} />
    case 'result':
      return <ResultStep state={state} />
  }
}

export function DecisionDialog() {
  const state = useSyncExternalStore(subscribe, getState)
  const open = state.step !== 'closed'

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeDecisionDialog()}>
      {open ? (
        <DialogContent className="max-w-xl">
          <DialogBody />
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
