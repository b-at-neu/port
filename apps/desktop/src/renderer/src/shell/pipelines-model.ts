// Pure projection onto the sidebar's Pipelines section — one row per
// registered repository.
import type { RepoId, RepositoryEntry } from '../../../shared/repos'
import type { BoardSnapshot } from '../../../shared/board/types'
import type { DispatchOwner } from '../../../shared/dispatch/types'
import type { ReconciledItem } from '../../../shared/state/types'
import { needsYouItems, repoNeedsYou } from '../../../shared/board/needs-you'
import { PHASE_NAMES } from '../lib/phase'
import type { PillStatus } from '../components/status-pill'

export interface PipelineSessionRow {
  readonly key: string
  readonly number: number
  readonly label: string
  readonly dot: 'attention' | 'working' | 'idle'
}

export interface ReadyPipelineRow {
  readonly ready: true
  readonly repoId: RepoId
  readonly name: string
  readonly pill: { readonly status: PillStatus; readonly label: string }
  /** This repository's own cockpit ownership — `'none'` before the first read. */
  readonly owner: DispatchOwner
  readonly unreadableMessage: string | null
  readonly inFlight: number
  readonly needsYou: boolean
  readonly sessions: readonly PipelineSessionRow[]
}

export interface NotReadyPipelineRow {
  readonly ready: false
  readonly repoId: RepoId
  readonly name: string
}

export type PipelineRow = ReadyPipelineRow | NotReadyPipelineRow

function sessionsFor(repoId: RepoId, items: readonly ReconciledItem[], needsYouNumbers: ReadonlySet<number>): PipelineSessionRow[] {
  const rows: PipelineSessionRow[] = []
  for (const item of items) {
    const liveAgent = item.agents.find((a) => a.activity !== 'dormant')
    const liveSession = item.sessions.find((s) => s.activity !== 'dormant')
    if (liveAgent === undefined && liveSession === undefined) continue

    const stageKey = item.stages.find((label) => label.role === item.stage)?.key ?? null
    const phaseName = stageKey !== null ? (PHASE_NAMES[stageKey] ?? stageKey) : 'Unstaged'
    const activity = liveAgent?.activity ?? liveSession?.activity ?? 'dormant'
    const dot: PipelineSessionRow['dot'] = needsYouNumbers.has(item.number) ? 'attention' : activity === 'active' ? 'working' : 'idle'

    rows.push({ key: `${repoId}-${item.number}`, number: item.number, label: `#${item.number} ${phaseName}`, dot })
  }
  return rows
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
export function pipelinesModel(repos: readonly RepositoryEntry[], snapshot: BoardSnapshot | undefined, now: Date = new Date()): readonly PipelineRow[] {
  const needsYou = snapshot !== undefined ? needsYouItems(snapshot, now) : []
  const needsYouNumbers = new Map<RepoId, Set<number>>()
  for (const item of needsYou) {
    if (item.repoId === null || item.number === null) continue
    const numbers = needsYouNumbers.get(item.repoId) ?? new Set<number>()
    numbers.add(item.number)
    needsYouNumbers.set(item.repoId, numbers)
  }

  return repos.map((entry): PipelineRow => {
    if (!('config' in entry)) return { ready: false, repoId: entry.id, name: entry.displayName }

    const repoState = snapshot?.state.repositories.find((r) => r.repoId === entry.id)
    const items = repoState !== undefined && repoState.ok ? repoState.items : []
    const tick = snapshot?.tick.find((t) => t.repoId === entry.id)
    const numbers = needsYouNumbers.get(entry.id) ?? new Set<number>()
    const dispatchStatus = snapshot?.dispatch.find((d) => d.repoId === entry.id)
    const owner: DispatchOwner = dispatchStatus?.owner ?? 'none'

    return {
      ready: true,
      repoId: entry.id,
      name: entry.config.repo,
      pill: pillFor(snapshot, entry.id, owner),
      owner,
      unreadableMessage: dispatchStatus?.unreadableMessage ?? null,
      inFlight: tick?.claims.length ?? 0,
      needsYou: repoNeedsYou(needsYou, entry.id) > 0,
      sessions: sessionsFor(entry.id, items, numbers),
    }
  })
}
