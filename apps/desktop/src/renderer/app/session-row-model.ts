// Pure dot and state-label derivation for an operator session row in the sidebar.
import type { HostedSessionSnapshot, SessionPhase } from '@/types/hosting'
import { waitingLabelOf } from '@/renderer/session/interaction-copy'

type RowSession = Pick<HostedSessionSnapshot, 'phase' | 'pendingPermissions'>

const PHASE_LABEL: Record<SessionPhase, string> = {
  starting: 'Starting',
  ready: 'Idle',
  streaming: 'Working',
  interrupting: 'Stopping',
  closing: 'Closing',
  ended: 'Ended',
}

export function sessionStateLabel(session: RowSession): string {
  return waitingLabelOf(session) ?? PHASE_LABEL[session.phase]
}

export function dotFor(session: RowSession): { readonly className: string; readonly label: string } {
  const label = sessionStateLabel(session)
  if (waitingLabelOf(session) !== null) return { className: 'bg-phase-needs-you-dot animate-pulse', label }
  if (session.phase === 'starting' || session.phase === 'streaming') return { className: 'bg-working-dot', label }
  return { className: 'bg-idle-dot', label }
}
