// DESIGN §3 Session header — 44px, title, phase pill, Stop/Close, the "…" menu.
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ScreenHeader } from '../components/screen-header'
import { StatusPill } from '../components/status-pill'
import type { PillStatus } from '../components/status-pill'
import { CapacityMenu } from './capacity-menu'
import { END_COPY, PHASE_COPY } from './copy'
import { sessionDisplayLabel } from '../../../shared/hosting/label'
import type { HostedSessionSnapshot, SessionPhase } from '../../../shared/hosting/types'

const PHASE_STATUS: Readonly<Record<SessionPhase, PillStatus>> = {
  starting: 'working',
  ready: 'idle',
  streaming: 'working',
  interrupting: 'working',
  closing: 'idle',
  ended: 'idle',
}

const PHASE_LABEL: Readonly<Record<Exclude<SessionPhase, 'ended'>, string>> = {
  starting: 'Starting',
  ready: 'Idle',
  streaming: 'Streaming',
  interrupting: 'Stopping…',
  closing: 'Closing…',
}

export function SessionHeader({
  snapshot,
  repoLabel,
  changesOpen,
  onToggleChanges,
  onStop,
  onClose,
  onDismiss,
}: {
  readonly snapshot: HostedSessionSnapshot
  readonly repoLabel: string
  readonly changesOpen: boolean
  readonly onToggleChanges: () => void
  readonly onStop: () => void
  readonly onClose: () => void
  readonly onDismiss: () => void
}) {
  const { phase } = snapshot
  const phaseCopy = PHASE_COPY[phase]
  const label = phase === 'ended' ? (snapshot.end !== null ? END_COPY[snapshot.end.reason].title : '') : PHASE_LABEL[phase]

  return (
    <ScreenHeader className="justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate">{sessionDisplayLabel({ title: snapshot.title, origin: snapshot.origin }, repoLabel)}</span>
        <StatusPill status={PHASE_STATUS[phase]} label={label} />
        {snapshot.workspace.worktree !== null ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="truncate font-mono text-meta text-muted-foreground">{snapshot.workspace.worktree.branch}</span>
            </TooltipTrigger>
            <TooltipContent>{snapshot.workspace.worktree.path}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {snapshot.workspace.root !== null ? (
          <Button variant={changesOpen ? 'secondary' : 'outline'} size="small" aria-pressed={changesOpen} onClick={onToggleChanges}>
            Changes
          </Button>
        ) : null}
        {phaseCopy.stop !== 'hidden' ? (
          <Button variant="outline" size="small" disabled={phaseCopy.stop === 'disabled' || phaseCopy.stop === 'stopping'} onClick={onStop}>
            {phaseCopy.stop === 'stopping' ? 'Stopping…' : 'Stop'}
          </Button>
        ) : null}
        {phaseCopy.close !== 'hidden' ? (
          <Button variant="outline" size="small" disabled={phaseCopy.close === 'closing'} onClick={onClose}>
            {phaseCopy.close === 'closing' ? 'Closing…' : 'Close session'}
          </Button>
        ) : null}
        <CapacityMenu onDismiss={onDismiss} showDismiss={phase === 'ended'} />
      </div>
    </ScreenHeader>
  )
}
