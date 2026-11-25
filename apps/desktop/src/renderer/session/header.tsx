// DESIGN §3 Session header — 44px, title, phase pill, Stop/Close, the "…" menu.
import { Button } from '@/renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { ScreenHeader } from '@/renderer/components/screen-header'
import { PhasePill } from '@/renderer/components/phase-pill'
import { StatusPill } from '@/renderer/components/status-pill'
import { NEEDS_YOU_TONE } from '@/renderer/lib/phase-tone'
import { waitingLabelOf } from '@/renderer/session/model'
import type { PillStatus } from '@/types/components'
import { CapacityMenu } from '@/renderer/session/capacity-menu'
import { CHANGES_BUTTON, CLOSE_BUTTON, CLOSING_BUTTON, DETACHED_BRANCH, END_COPY, PHASE_COPY, PHASE_LABEL, STOP_BUTTON, STOPPING_BUTTON } from '@/renderer/session/copy'
import { sessionDisplayLabel } from '@/utils/hosting/label'
import type { HostedSessionSnapshot, SessionPhase } from '@/types/hosting'

const PHASE_STATUS: Readonly<Record<SessionPhase, PillStatus>> = {
  starting: 'working',
  ready: 'idle',
  streaming: 'working',
  interrupting: 'working',
  closing: 'idle',
  ended: 'idle',
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
  const waiting = waitingLabelOf(snapshot)

  return (
    <ScreenHeader className="justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate">{sessionDisplayLabel({ title: snapshot.title, origin: snapshot.origin }, repoLabel)}</span>
        {waiting !== null ? <PhasePill tone={NEEDS_YOU_TONE} label={waiting} /> : <StatusPill status={PHASE_STATUS[phase]} label={label} />}
        {snapshot.workspace.worktree !== null ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="truncate font-mono text-meta text-muted-foreground">{snapshot.workspace.worktree.branch ?? DETACHED_BRANCH}</span>
            </TooltipTrigger>
            <TooltipContent>{snapshot.workspace.worktree.path}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {snapshot.workspace.root !== null ? (
          <Button variant={changesOpen ? 'secondary' : 'outline'} size="small" aria-pressed={changesOpen} onClick={onToggleChanges}>
            {CHANGES_BUTTON}
          </Button>
        ) : null}
        {phaseCopy.stop !== 'hidden' ? (
          <Button variant="outline" size="small" disabled={phaseCopy.stop === 'disabled' || phaseCopy.stop === 'stopping'} onClick={onStop}>
            {phaseCopy.stop === 'stopping' ? STOPPING_BUTTON : STOP_BUTTON}
          </Button>
        ) : null}
        {phaseCopy.close !== 'hidden' ? (
          <Button variant="outline" size="small" disabled={phaseCopy.close === 'closing'} onClick={onClose}>
            {phaseCopy.close === 'closing' ? CLOSING_BUTTON : CLOSE_BUTTON}
          </Button>
        ) : null}
        <CapacityMenu usage={snapshot.usage} onDismiss={onDismiss} showDismiss={phase === 'ended'} />
      </div>
    </ScreenHeader>
  )
}
