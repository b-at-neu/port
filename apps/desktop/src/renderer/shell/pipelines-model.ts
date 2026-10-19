// Pure projection onto the sidebar's Pipelines section — one row per
// registered repository.
import type { RepoId, RepositoryEntry } from '@/utils/repos'
import type { BoardSnapshot } from '@/types/board'
import type { DispatchOwner } from '@/types/dispatch'
import type { ReconciledItem } from '@/types/state'
import type { HostedSessionSnapshot } from '@/types/hosting'
import { needsYouItems, repoNeedsYou } from '@/renderer/board/needs-you'
import { stageKeyOf } from '@/renderer/board/row-model'
import { stageAgentPhaseName } from '@/renderer/board/copy'
import { PHASE_NAMES } from '@/renderer/lib/phase'
import type { PillStatus } from '@/types/components'
import type { PipelineRow, PipelineSessionRow } from '@/types/shell'

function sessionsFor(repoId: RepoId, items: readonly ReconciledItem[], needsYouNumbers: ReadonlySet<number>): PipelineSessionRow[] {
  const rows: PipelineSessionRow[] = []
  for (const item of items) {
    const liveAgent = item.agents.find((a) => a.activity !== 'dormant')
    const liveSession = item.sessions.find((s) => s.activity !== 'dormant')
    if (liveAgent === undefined && liveSession === undefined) continue

    const stageKey = stageKeyOf(item.stages, item.stage)
    const phaseName = stageKey !== null ? (PHASE_NAMES[stageKey] ?? stageKey) : 'Unstaged'
    const activity = liveAgent?.activity ?? liveSession?.activity ?? 'dormant'
    const dot: PipelineSessionRow['dot'] = needsYouNumbers.has(item.number) ? 'attention' : activity === 'active' ? 'working' : 'idle'
    const transcript: PipelineSessionRow['transcript'] =
      liveAgent !== undefined ? { sessionId: liveAgent.sessionId, agentId: liveAgent.agentId } : liveSession !== undefined ? { sessionId: liveSession.sessionId, agentId: null } : null

    rows.push({ key: `${repoId}-${item.number}`, repoId, number: item.number, label: `#${item.number} ${phaseName}`, dot, sessionKey: null, transcript })
  }
  return rows
}

/** A live stage session's own row, following `sidebar-sessions.tsx`'s own dot rules. `repoId` is passed in rather than read off `session` — this is only ever called once `session.repoId` has already been narrowed to match it. */
function stageRowFor(repoId: RepoId, session: HostedSessionSnapshot): PipelineSessionRow {
  const stage = session.stage
  if (stage === null) throw new Error('stageRowFor called with a non-stage snapshot')
  const phaseName = stageAgentPhaseName(stage.agent)
  const dot: PipelineSessionRow['dot'] = session.pendingPermissions.length > 0 ? 'attention' : session.phase === 'starting' || session.phase === 'streaming' ? 'working' : 'idle'
  return { key: session.sessionKey, repoId, number: stage.number, label: `#${String(stage.number)} ${phaseName}`, dot, sessionKey: session.sessionKey, transcript: null }
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

/** A not-`ready` repository gets a bare row with no menu. `snapshot` may be
 *  `undefined` before the first read; a ready row then falls back to paused. */
export function pipelinesModel(
  repos: readonly RepositoryEntry[],
  snapshot: BoardSnapshot | undefined,
  now: Date = new Date(),
  sessions: readonly HostedSessionSnapshot[] = [],
): readonly PipelineRow[] {
  const needsYou = snapshot !== undefined ? needsYouItems(snapshot, now) : []
  const needsYouNumbers = new Map<RepoId, Set<number>>()
  for (const item of needsYou) {
    if (item.repoId === null || item.number === null) continue
    const numbers = needsYouNumbers.get(item.repoId) ?? new Set<number>()
    numbers.add(item.number)
    needsYouNumbers.set(item.repoId, numbers)
  }

  return repos.map((entry): PipelineRow => {
    const stageRows = sessions.filter((s) => s.phase !== 'ended' && s.stage !== null && s.repoId === entry.id).map((s) => stageRowFor(entry.id, s))
    if (!('config' in entry)) return { ready: false, repoId: entry.id, name: entry.displayName, sessions: stageRows }

    const repoState = snapshot?.state.repositories.find((r) => r.repoId === entry.id)
    const items = repoState !== undefined && repoState.ok ? repoState.items : []
    const tick = snapshot?.tick.find((t) => t.repoId === entry.id)
    const numbers = needsYouNumbers.get(entry.id) ?? new Set<number>()
    const dispatchStatus = snapshot?.dispatch.find((d) => d.repoId === entry.id)
    const owner: DispatchOwner = dispatchStatus?.owner ?? 'none'

    const itemRows = sessionsFor(entry.id, items, numbers)
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
