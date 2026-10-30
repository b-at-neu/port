// Work on's confirmation for a blocked ticket or an epic — lists every reason that applies.
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/renderer/components/ui/alert-dialog'
import { BACKLOG_START_ANYWAY, backlogBlockedReasonCopy, backlogBlockerLine, backlogBlockerTruncatedCopy, backlogEpicReasonCopy, backlogStartAnywayTitle } from '@/renderer/backlog/copy'
import type { WorkOnReasons } from '@/types/backlog'

interface WorkOnConfirmProps {
  readonly open: boolean
  readonly number: number
  readonly reasons: WorkOnReasons | null
  readonly onCancel: () => void
  readonly onConfirm: () => void
}

export function WorkOnConfirm({ open, number, reasons, onCancel, onConfirm }: WorkOnConfirmProps) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      {reasons !== null ? (
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{backlogStartAnywayTitle(number)}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-2">
                {reasons.blockers.length > 0 ? (
                  <div>
                    <p>{backlogBlockedReasonCopy(reasons.blockers.length)}</p>
                    <ul className="list-inside list-disc">
                      {reasons.blockers.map((blocker) => (
                        <li key={blocker.number}>
                          <a href={blocker.url} target="_blank" rel="noreferrer" className="text-primary-text hover:underline">
                            {backlogBlockerLine(blocker)}
                          </a>
                        </li>
                      ))}
                    </ul>
                    {reasons.truncation !== null ? <p>{backlogBlockerTruncatedCopy(reasons.truncation.shown, reasons.truncation.total)}</p> : null}
                  </div>
                ) : null}
                {reasons.subIssueCount > 0 ? <p>{backlogEpicReasonCopy(reasons.subIssueCount)}</p> : null}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirm}>{BACKLOG_START_ANYWAY}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      ) : null}
    </AlertDialog>
  )
}
