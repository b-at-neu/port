// Pure projection onto the sidebar — one group per registered repository, plus the sessions that
// belong to none.
import type { RepoId, RepositoryEntry } from '@/utils/repos'
import type { BoardSnapshot, NeedsYouItem } from '@/types/board'
import type { DispatchOwner } from '@/types/dispatch'
import type { HostedSessionSnapshot, SessionMarks } from '@/types/hosting'
import { orderSessions } from '@/utils/shell/session-order'
import type { TicketIndex } from '@/types/ticket'
import { repoNeedsYou } from '@/renderer/board/needs-you'
import { ticketIndex, ticketLabel } from '@/utils/tickets/ticket'
import type { PhaseTone, PillStatus } from '@/types/components'
import type { PipelineRow, PipelineSessionRow, RunStateDisplay, SidebarModel } from '@/types/shell'
import { ticketViewOf, viewOfKey } from '@/renderer/lib/ticket-view'
import { agentStageName, stageNameOf } from '@/utils/pipeline/stages'
import { phaseTone } from '@/renderer/lib/phase-tone'
import { classifyHandbackText } from '@/utils/stage/handback-text'

function statusTextOf(tone: PhaseTone, phaseName: string): string {
  return tone.palette === 'needs-you' ? 'Needs you' : phaseName
}

/** Every sidebar row is actively running, so its dot pulses in its phase colour. */
function runningTone(tone: PhaseTone): PhaseTone {
  return { ...tone, pulse: true }
}

function operatorNeeded(session: HostedSessionSnapshot): boolean {
  return session.pendingPermissions.length > 0 || classifyHandbackText(session.lastResult?.text ?? '') !== null
}

function isRunning(session: HostedSessionSnapshot): boolean {
  return (session.phase === 'starting' || session.phase === 'streaming') && !operatorNeeded(session)
}

function sessionsFor(repoId: RepoId, index: TicketIndex, needsYouNumbers: ReadonlySet<number>): PipelineSessionRow[] {
  const rows: PipelineSessionRow[] = []
  for (const ticket of index.tickets) {
    const item = ticket.primary
    if (item.stage === 'gate' || item.stage === 'terminal' || needsYouNumbers.has(ticket.ref.number)) continue
    const liveAgent = item.agents.find((a) => a.activity === 'active')
    const liveSession = item.sessions.find((s) => s.activity === 'active')
    if (liveAgent === undefined && liveSession === undefined) continue

    const view = ticketViewOf(item)
    const tone = runningTone(phaseTone({ view, active: true, waitingOnYou: false, operatorNeeded: false }))
    const transcript: PipelineSessionRow['transcript'] =
      liveAgent !== undefined ? { sessionId: liveAgent.sessionId, agentId: liveAgent.agentId } : liveSession !== undefined ? { sessionId: liveSession.sessionId, agentId: null } : null

    const phaseName = stageNameOf(view)
    rows.push({ key: `${repoId}-${ticket.ref.number}`, repoId, number: ticket.ref.number, label: ticketLabel(ticket.ref), tone, statusText: statusTextOf(tone, phaseName), phaseName, sessionKey: null, transcript })
  }
  return rows
}

function ticketNumberOf(stage: NonNullable<HostedSessionSnapshot['stage']>, index: TicketIndex): number {
  return index.byNumber.get(stage.number)?.ref.number ?? stage.number
}

/** A live stage session's own row. A permission prompt or a `QUESTIONS FOR HUMAN:`/`BLOCKED:` hand-back means the operator is needed, whatever phase it is in. `repoId` is passed in rather than read off `session` — this is only ever called once `session.repoId` has already been narrowed to match it. */
function stageRowFor(repoId: RepoId, session: HostedSessionSnapshot, index: TicketIndex): PipelineSessionRow {
  const stage = session.stage
  if (stage === null) throw new Error('stageRowFor called with a non-stage snapshot')
  const ticket = index.byNumber.get(stage.number)
  const label = session.title ?? (ticket !== undefined ? ticketLabel(ticket.ref) : `#${String(stage.number)}`)
  const tone = runningTone(phaseTone({ view: viewOfKey(stage.trigger, stage.kind), active: true, waitingOnYou: false, operatorNeeded: operatorNeeded(session) }))
  const phaseName = agentStageName(stage.agent)
  return { key: session.sessionKey, repoId, number: ticketNumberOf(stage, index), label, tone, statusText: statusTextOf(tone, phaseName), phaseName, sessionKey: session.sessionKey, transcript: null }
}

export function phaseLineOf(row: Pick<PipelineSessionRow, 'tone' | 'phaseName'>): string {
  return row.tone.palette === 'needs-you' ? `${row.phaseName} · Needs you` : row.phaseName
}

/** A `draining` repo reads `stopped` only on positive evidence that nothing is left: a non-blind tick with no claims and no live stage session. A missing or blind tick reports `claims: []`, which must not pass for a quiet repo. */
export function displayRunState(snapshot: BoardSnapshot | undefined, repoId: RepoId, sessions: readonly HostedSessionSnapshot[]): RunStateDisplay {
  if (snapshot === undefined) return 'stopped'
  const persisted = snapshot.runStates.repositories.find((r) => r.repoId === repoId)?.state ?? 'paused'
  if (persisted === 'dispatching') return 'dispatching'
  if (persisted === 'paused') return 'stopped'

  const tick = snapshot.tick.find((t) => t.repoId === repoId)
  if (tick === undefined || tick.blind !== null || tick.claims.length > 0) return 'draining'
  const live = sessions.some((s) => s.phase !== 'ended' && s.stage !== null && s.repoId === repoId)
  return live ? 'draining' : 'stopped'
}

/** Ownership gates the pill ahead of run state — `unreadable` has its own fixed pill,
 *  never `dispatching`/`draining`/`stopped`. */
function pillFor(snapshot: BoardSnapshot | undefined, repoId: RepoId, owner: DispatchOwner, sessions: readonly HostedSessionSnapshot[]): { readonly status: PillStatus; readonly label: string } {
  if (snapshot === undefined) return { status: 'idle', label: 'Stopped' }
  const { store } = snapshot.runStates
  if (store.kind === 'unread') return { status: 'idle', label: 'Stopped' }
  if (store.kind === 'unreadable') return { status: 'danger', label: 'Stopped' }
  if (owner === 'unreadable') return { status: 'danger', label: 'Stopped' }

  const display = displayRunState(snapshot, repoId, sessions)
  if (display === 'dispatching') return { status: 'success', label: 'Running' }
  if (display === 'draining') return { status: 'attention', label: 'Draining' }
  return { status: 'idle', label: 'Stopped' }
}

/** Lists only running sessions that do not need the operator, and their dots pulse. A not-`ready` repository gets a bare row with no menu; before the first read a ready row falls back to stopped. Every row carries its own user sessions, and the rest go to `otherSessions`. */
export function pipelinesModel(
  repos: readonly RepositoryEntry[],
  snapshot: BoardSnapshot | undefined,
  needsYou: readonly NeedsYouItem[],
  sessions: readonly HostedSessionSnapshot[] = [],
  marks?: SessionMarks,
): SidebarModel {
  const userSessions = orderSessions(sessions, marks)
  const registered = new Set<RepoId>(repos.map((entry) => entry.id))
  return {
    repos: repoRows(repos, snapshot, needsYou, sessions, userSessions),
    otherSessions: userSessions.filter((session) => session.repoId === null || !registered.has(session.repoId)),
  }
}

function repoRows(
  repos: readonly RepositoryEntry[],
  snapshot: BoardSnapshot | undefined,
  needsYou: readonly NeedsYouItem[],
  sessions: readonly HostedSessionSnapshot[],
  userSessions: readonly HostedSessionSnapshot[],
): readonly PipelineRow[] {
  const needsYouNumbers = new Map<RepoId, Set<number>>()
  for (const item of needsYou) {
    const number = item.ticket?.number ?? item.number
    if (item.repoId === null || number === null) continue
    const numbers = needsYouNumbers.get(item.repoId) ?? new Set<number>()
    numbers.add(number)
    needsYouNumbers.set(item.repoId, numbers)
  }

  return repos.map((entry): PipelineRow => {
    const repoState = snapshot?.state.repositories.find((r) => r.repoId === entry.id)
    const index = ticketIndex(repoState !== undefined && repoState.ok ? repoState.items : [])
    const stageSessions = sessions.filter((s) => s.phase !== 'ended' && s.stage !== null && s.repoId === entry.id)
    const stageRows = stageSessions.filter(isRunning).map((s) => stageRowFor(entry.id, s, index))
    const ownSessions = userSessions.filter((session) => session.repoId === entry.id)
    if (!('config' in entry)) return { ready: false, repoId: entry.id, name: entry.displayName, sessions: stageRows, userSessions: ownSessions }

    const tick = snapshot?.tick.find((t) => t.repoId === entry.id)
    const numbers = needsYouNumbers.get(entry.id) ?? new Set<number>()
    const dispatchStatus = snapshot?.dispatch.find((d) => d.repoId === entry.id)
    const owner: DispatchOwner = dispatchStatus?.owner ?? 'none'

    const itemRows = sessionsFor(entry.id, index, numbers)
    const stageNumbers = new Set(stageSessions.flatMap((s) => (s.stage !== null ? [ticketNumberOf(s.stage, index)] : [])))

    return {
      ready: true,
      repoId: entry.id,
      name: entry.config.repo,
      pill: pillFor(snapshot, entry.id, owner, sessions),
      owner,
      unreadableMessage: dispatchStatus?.unreadableMessage ?? null,
      inFlight: tick?.claims.length ?? 0,
      needsYouCount: repoNeedsYou(needsYou, entry.id),
      sessions: [...itemRows.filter((row) => !stageNumbers.has(row.number)), ...stageRows],
      userSessions: ownSessions,
    }
  })
}
