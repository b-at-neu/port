// The take-over-from-the-terminal confirmation (#331) — shown only once the
// sidebar's Take over… menu item arms it.
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { useTakeOverRequest, setTakeOverRequest } from './stores'
import { useRunStateCommand } from './run-state-command'

export function TakeOverConfirmDialog() {
  const request = useTakeOverRequest()
  const runState = useRunStateCommand()
  const open = request !== null

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && setTakeOverRequest(null)}>
      {request !== null ? (
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Take over {request.name} from the terminal?</AlertDialogTitle>
            <AlertDialogDescription>
              Only do this if /port:pipeline isn&apos;t running for this repo in any terminal. This app can&apos;t tell whether it is. A cockpit still running there stops at its next tick.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void runState.confirmTakeOver(request.repoId, request.name)}>Take over</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      ) : null}
    </AlertDialog>
  )
}
