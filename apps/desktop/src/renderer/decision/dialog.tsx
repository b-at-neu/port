// The decision dialog — a shadcn Dialog over decision/controller.ts's
// useSyncExternalStore state, the same shape gate/dialog.tsx establishes.
import { useSyncExternalStore } from 'react'
import { Dialog, DialogContent } from '@/renderer/components/ui/dialog'
import { closeDecisionDialog, getState, subscribe } from '@/renderer/decision/controller'
import { AlertDialog } from '@/renderer/components/ui/alert-dialog'
import { ConfirmGrantStep, ConfirmReviseStep, ConfirmUnblockStep } from '@/renderer/decision/dialog-steps'

function DialogBody() {
  const state = useSyncExternalStore(subscribe, getState)
  switch (state.step) {
    case 'closed':
      return null
    case 'confirm-unblock':
      return <ConfirmUnblockStep state={state} />
    case 'confirm-revise':
      return <ConfirmReviseStep state={state} />
    case 'confirm-grant':
      return null
  }
}

export function DecisionDialog() {
  const state = useSyncExternalStore(subscribe, getState)
  const open = state.step !== 'closed'

  if (state.step === 'confirm-grant') {
    return (
      <AlertDialog open onOpenChange={(next) => !next && closeDecisionDialog()}>
        <ConfirmGrantStep state={state} />
      </AlertDialog>
    )
  }

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
