// Pure projection onto the sidebar's Pipelines section — one row per
// registered repository.
import type { RepoId, RepositoryEntry } from '@/utils/repos'
import type { BoardSnapshot, NeedsYouItem } from '@/types/board'
import type { DispatchOwner } from '@/types/dispatch'
import type { HostedSessionSnapshot } from '@/types/hosting'
import type { TicketIndex } from '@/types/ticket'
import { repoNeedsYou } from '@/renderer/board/needs-you'
import { ticketIndex, ticketLabel } from '@/utils/tickets/ticket'
import type { PhaseTone, PillStatus } from '@/types/components'
import type { PipelineRow, PipelineSessionRow } from '@/types/shell'
import { stageKeyOf } from '@/renderer/board/row-model'
import { stageAgentPhaseName } from '@/renderer/board/copy'
import { PHASE_NAMES } from '@/renderer/lib/phase'
import { phaseTone } from '@/renderer/lib/phase-tone'
import { classifyHandbackText } from '@/utils/stage/handback-text'

function statusTextOf(tone: PhaseTone, phaseName: string): string {
  return tone.palette === 'needs-you' ? 'Needs you' : phaseName
}

function sessionsFor(repoId: RepoId, index: TicketIndex, needsYouNumbers: ReadonlySet<number>): PipelineSessionRow[] {
  const rows: PipelineSessionRow[] = []
  for (const ticket of index.tickets) {
    const item = ticket.primary
    const liveAgent = item.agents.find((a) => a.activity !== 'dormant')
    const liveSession = item.sessions.find((s) => s.activity !== 'dormant')
    if (liveAgent === undefined && liveSession === undefined) continue

    const activity = liveAgent?.activity ?? liveSession?.activity ?? 'dormant'
    const stageKey = stageKeyOf(item.stages, item.stage)
    const tone = phaseTone({ stageKey, active: activity === 'active', waitingOnYou: needsYouNumbers.has(ticket.ref.number), operatorNeeded: false })
    const transcript: PipelineSessionRow['transcript'] =
      liveAgent !== undefined ? { sessionId: liveAgent.sessionId, agentId: liveAgent.agentId } : liveSession !== undefined ? { sessionId: liveSession.sessionId, agentId: null } : null

    const phaseName = stageKey !== null ? (PHASE_NAMES[stageKey] ?? stageKey) : 'Unstaged'
    rows.push({ key: `${repoId}-${ticket.ref.number}`, repoId, number: ticket.ref.number, label: ticketLabel(ticket.ref), tone, statusText: statusTextOf(tone, phaseName), phaseName, sessionKey: null, transcript })
  }
  return rows
}

/** A live stage session's own row. A permission prompt or a `QUESTIONS FOR HUMAN:`/`BLOCKED:` hand-back means the operator is needed, whatever phase it is in. `repoId` is passed in rather than read off `session` — this is only ever called once `session.repoId` has already been narrowed to match it. */
function stageRowFor(repoId: RepoId, session: HostedSessionSnapshot, index: TicketIndex): PipelineSessionRow {
  const stage = session.stage
  if (stage === null) throw new Error('stageRowFor called with a non-stage snapshot')
  const ticket = index.byNumber.get(stage.number)
  const label = session.title ?? (ticket !== undefined ? ticketLabel(ticket.ref) : `#${String(stage.number)}`)
  const operatorNeeded = session.pendingPermissions.length > 0 || classifyHandbackText(session.lastResult?.text ?? '') !== null
  const tone = phaseTone({ stageKey: stage.trigger, active: true, waitingOnYou: false, operatorNeeded })
  const phaseName = stageAgentPhaseName(stage.agent)
  return { key: session.sessionKey, repoId, number: ticket?.ref.number ?? stage.number, label, tone, statusText: statusTextOf(tone, phaseName), phaseName, sessionKey: session.sessionKey, transcript: null }
}

export function phaseLineOf(row: Pick<PipelineSessionRow, 'tone' | 'phaseName'>): string {
  return row.tone.palette === 'needs-you' ? `${row.phaseName} · Needs you` : row.phaseName
}

/** Ownership gates the pill ahead of run state — `terminal`/`unreadable` each have their
 *  own fixed pill, never `dispatching`/`draining`/`paused`. */
function pillFor(snapshot: BoardSnapshot | undefined, repoId: RepoId, owner: DispatchOwner): { readonly status: PillStatus; readonly label: string } {
  if (snapshot === undefined) return { status: 'idle', label: 'Paused' }
  const { store } = snapshot.runStates
  if (store.kind === 'unread') return { status: 'idle', label: 'Paused' }
  if (store.kind === 'unreadable') return { status: 'danger', label: 'Paused' }
  if (owner === 'unreadable') return { status: 'danger', label: 'Paused' }
  if (owner === 'terminal') return { status: 'idle', label: 'Terminal' }

  const runState = snapshot.runStates.repositories.find((r) => r.repoId === repoId)?.state ?? 'paused'
  if (runState === 'dispatching') return { status: 'success', label: 'Running' }
  if (runState === 'draining') return { status: 'attention', label: 'Draining' }
  return { status: 'idle', label: 'Paused' }
}

/** A not-`ready` repository gets a bare row with no menu; before the first read a ready row falls back to paused.
 *  `needsYou` is the visible list, never re-derived here, so a dismissed item lights no dot. */
export function pipelinesModel(
  repos: readonly RepositoryEntry[],
  snapshot: BoardSnapshot | undefined,
  needsYou: readonly NeedsYouItem[],
  sessions: readonly HostedSessionSnapshot[] = [],
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
    const stageRows = sessions.filter((s) => s.phase !== 'ended' && s.stage !== null && s.repoId === entry.id).map((s) => stageRowFor(entry.id, s, index))
    if (!('config' in entry)) return { ready: false, repoId: entry.id, name: entry.displayName, sessions: stageRows }

    const tick = snapshot?.tick.find((t) => t.repoId === entry.id)
    const numbers = needsYouNumbers.get(entry.id) ?? new Set<number>()
    const dispatchStatus = snapshot?.dispatch.find((d) => d.repoId === entry.id)
    const owner: DispatchOwner = dispatchStatus?.owner ?? 'none'

    const itemRows = sessionsFor(entry.id, index, numbers)
    const stageNumbers = new Set(stageRows.map((r) => r.number))

    return {
      ready: true,
      repoId: entry.id,
      name: entry.config.repo,
      pill: pillFor(snapshot, entry.id, owner),
      owner,
      unreadableMessage: dispatchStatus?.unreadableMessage ?? null,
      inFlight: tick?.claims.length ?? 0,
      needsYou: repoNeedsYou(needsYou, entry.id) > 0,
      sessions: [...itemRows.filter((row) => !stageNumbers.has(row.number)), ...stageRows],
    }
  })
}
