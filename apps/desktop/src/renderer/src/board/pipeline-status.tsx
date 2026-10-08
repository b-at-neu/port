// The Board's pipeline status strip: store/clock lines, then one line per
// repository with its own owner line and budget notes underneath.
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { BoardSnapshot } from '../../../shared/board/types'
import { budgetNoteLines, controlFor, observationClause, observationTitle, ownerLineCopy, runStateSuffix } from './owner'
import { setDispatchClaim } from './dispatch'
import { clockLineCopy, repositoryDetailLines, repositoryLineCopy, storeLineFor } from './tick'

export interface PipelineStatusProps {
  readonly snapshot: BoardSnapshot
  readonly now: Date
}

function OwnerLine({ snapshot, repoId }: { readonly snapshot: BoardSnapshot; readonly repoId: BoardSnapshot['dispatch'][number]['repoId'] }) {
  const status = snapshot.dispatch.find((d) => d.repoId === repoId)
  if (status === undefined) return null

  const observationPart = status.owner === 'app' ? observationClause(status.observed) : ''
  const title = status.owner === 'app' ? observationTitle(status.observed) : null
  const control = controlFor(status)
  const notes = budgetNoteLines(status)

  return (
    <div className="flex flex-col gap-0.5 pl-3">
      <div className="flex items-center gap-2 text-meta text-muted-foreground" title={title ?? undefined}>
        <span>
          {ownerLineCopy(status)}
          {runStateSuffix(status.runState)}
          {observationPart}
        </span>
        {control !== null ? (
          <Button variant="ghost" size="small" title={control.title} onClick={() => void setDispatchClaim(status.repoId, control.action === 'dispatch-claim-take')}>
            {control.label}
          </Button>
        ) : null}
      </div>
      {notes.map((note, index) => (
        <div key={index} className="pl-1 text-meta text-muted-foreground">
          {note}
        </div>
      ))}
    </div>
  )
}

export function PipelineStatus({ snapshot, now }: PipelineStatusProps) {
  const storeLine = storeLineFor(snapshot.runStates.store)

  return (
    <div className="flex flex-col gap-1 px-4 pb-2 text-meta text-muted-foreground">
      {storeLine !== null ? <div title={storeLine.title ?? undefined}>{storeLine.text}</div> : null}
      <div>{clockLineCopy(snapshot.nextWakeupAt, snapshot.health, now)}</div>
      {snapshot.tick.map((report) => {
        const dispatchStatus = snapshot.dispatch.find((d) => d.repoId === report.repoId)
        const owner = dispatchStatus?.owner ?? 'cockpit'
        const repoRunState = snapshot.runStates.repositories.find((r) => r.repoId === report.repoId) ?? { repoId: report.repoId, state: 'paused' as const, since: null }
        const details = repositoryDetailLines(report, owner)
        const line = <div>{repositoryLineCopy(report, repoRunState.state, dispatchStatus?.owner)}</div>

        return (
          <div key={report.repoId} className="flex flex-col gap-0.5">
            {details.length > 0 ? (
              <Tooltip>
                <TooltipTrigger asChild>{line}</TooltipTrigger>
                <TooltipContent>
                  {details.map((detail, index) => (
                    <div key={index}>{detail}</div>
                  ))}
                </TooltipContent>
              </Tooltip>
            ) : (
              line
            )}
            <OwnerLine snapshot={snapshot} repoId={report.repoId} />
          </div>
        )
      })}
    </div>
  )
}
