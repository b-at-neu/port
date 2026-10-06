// The plan gate dialog (#92, #319) — a shadcn `Dialog` over
// `gate/controller.ts`'s `useSyncExternalStore` state, in place of the
// deleted `view.ts`'s native `<dialog>`. Steps live in `dialog-steps.tsx` to
// stay under 500 lines. Closing via Esc or the scrim calls `closeGateDialog`,
// the same as every button that used to carry the `gate-cancel` action.
import { useSyncExternalStore } from 'react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { closeGateDialog, getState, subscribe } from './controller'
import { ClaimPickingStep, ClaimStatusStep, ErrorStep, FeedbackStep, LoadingStep, RefusedStep, ResultStep, ReviewingStep } from './dialog-steps'

function DialogBody() {
  const state = useSyncExternalStore(subscribe, getState)
  switch (state.step) {
    case 'closed':
      return null
    case 'claim-picking':
      return <ClaimPickingStep state={state} />
    case 'claim-loading':
      return <LoadingStep hint="Reading the plan gate…" />
    case 'claim-view':
      return <ClaimStatusStep claim={state.claim} acting={false} />
    case 'claim-acting':
      return <LoadingStep hint="Updating the plan gate…" />
    case 'claim-failed':
      return <ErrorStep line="Couldn't reach the main process." note={state.message} />
    case 'loading':
      return <LoadingStep hint={`Reading #${String(state.number)}…`} />
    case 'reviewing':
      return <ReviewingStep state={state} />
    case 'feedback':
      return <FeedbackStep state={state} />
    case 'answering':
      return <LoadingStep hint={`Answering #${String(state.number)}…`} />
    case 'refused':
      return <RefusedStep number={state.number} verdict={state.verdict} />
    case 'preflight-failed':
      return <ErrorStep line="Couldn't reach GitHub." note={state.message} />
    case 'result':
      return <ResultStep state={state} />
  }
}

export function GateDialog() {
  const state = useSyncExternalStore(subscribe, getState)
  const open = state.step !== 'closed'

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeGateDialog()}>
      {open ? (
        <DialogContent className="max-w-xl">
          <DialogBody />
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
