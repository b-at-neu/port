// DESIGN §4: a consequential action opens an `AlertDialog` — the pause
// pipeline confirmation, only shown while in-flight is above 0 (#316).
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { usePauseRequest, setPauseRequest } from './stores'
import { useRunStateCommand } from './run-state-command'

export function PauseConfirmDialog() {
  const request = usePauseRequest()
  const runState = useRunStateCommand()
  const open = request !== null

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && setPauseRequest(null)}>
      {request !== null ? (
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Pause {request.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {request.inFlight} {request.inFlight === 1 ? 'agent is' : 'agents are'} working on this repo. Pausing stops them and removes their in-flight labels. Nothing new starts until you run it
              again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => runState.confirmPause(request.repoId, request.name)}>Pause pipeline</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      ) : null}
    </AlertDialog>
  )
}
