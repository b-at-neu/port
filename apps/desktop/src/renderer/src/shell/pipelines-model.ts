// Pure projection from the repository registry and the board snapshot onto
// the sidebar's Pipelines section (#316) — one row per registered
// repository, DESIGN §3. No runtime imports: `sidebar-pipelines.tsx` is the
// one consumer, the same split `shared/board/project.ts` already draws
// between pure derivation and its own renderer.
import type { RepoId, RepositoryEntry } from '../../../shared/repos'
import type { BoardSnapshot } from '../../../shared/board/types'
import type { ReconciledItem } from '../../../shared/state/types'
import { needsYouItems, repoNeedsYou } from '../../../shared/board/needs-you'
import { PHASE_NAMES } from '../lib/phase'

export type PillStatus = 'success' | 'attention' | 'idle' | 'danger'

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

function pillFor(snapshot: BoardSnapshot | undefined, repoId: RepoId): { readonly status: PillStatus; readonly label: string } {
  if (snapshot === undefined) return { status: 'idle', label: 'Paused' }
  const { store } = snapshot.runStates
  if (store.kind === 'unread') return { status: 'idle', label: 'Paused' }
  if (store.kind === 'unreadable') return { status: 'danger', label: 'Paused' }

  const runState = snapshot.runStates.repositories.find((r) => r.repoId === repoId)?.state ?? 'paused'
  if (runState === 'dispatching') return { status: 'success', label: 'Running' }
  if (runState === 'draining') return { status: 'attention', label: 'Draining' }
  return { status: 'idle', label: 'Paused' }
}

/** One row per registered repository (DESIGN §3's Pipelines section) — a
 *  not-`ready` repository gets a bare not-ready row with no menu, per the
 *  plan's **UX states**. `snapshot` may be `undefined` while `board:snapshot`
 *  has not resolved yet; every ready row then falls back to a paused pill
 *  with no sessions, rather than waiting on a second loading state. */
export function pipelinesModel(repos: readonly RepositoryEntry[], snapshot: BoardSnapshot | undefined): readonly PipelineRow[] {
  const needsYou = snapshot !== undefined ? needsYouItems(snapshot) : []
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

    return {
      ready: true,
      repoId: entry.id,
      name: entry.config.repo,
      pill: pillFor(snapshot, entry.id),
      inFlight: tick?.claims.length ?? 0,
      needsYou: repoNeedsYou(needsYou, entry.id) > 0,
      sessions: sessionsFor(entry.id, items, numbers),
    }
  })
}
