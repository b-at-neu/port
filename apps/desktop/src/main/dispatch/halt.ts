// Pause-then-stop-every-claim. Every write goes through applyItemAction, the same chokepoint
// the board's own row buttons use.
import { actionsFor, stageKeyOf } from '../../shared/actions/plan'
import type { ItemActionResult } from '../../shared/actions/types'
import { labelName } from '../../shared/labels/vocabulary'
import type { BoardSnapshot } from '../../shared/board/types'
import type { HaltItemOutcome, HaltReport } from '../../shared/dispatch/types'
import type { ReconciledItem } from '../../shared/state/types'
import type { RepoId } from '../../shared/repos'
import { applyItemAction as defaultApplyItemAction } from '../actions/apply'
import type { ApplyItemActionParams, ReadyEntry } from '../actions/apply'
import type { RunStateStore } from './store'

export interface HaltDispatchParams {
  readonly snapshot: BoardSnapshot
  /** One repository for `pause`, every ready repository for `halt`. An entry missing for a
   *  repository means every item there is skipped, never stopped. */
  readonly entries: readonly ReadyEntry[]
  readonly runStates: RunStateStore
  /** Written to `runStates` first, regardless of whether `entries` carries a ready entry for each. */
  readonly repoIds: readonly RepoId[]
  readonly auditDir: string
  readonly now: () => Date
}

export interface HaltDispatchDeps {
  readonly applyItemAction: (params: ApplyItemActionParams) => Promise<ItemActionResult>
  /** This app's own per-item stop, called before every `applyItemAction` so the session is asked
   *  to stop before its label is touched. A no-op default for a caller with no dispatch loop. */
  readonly stopFor?: (repoId: RepoId, number: number) => Promise<boolean>
  /** This app's own whole-repository stand-down, once per in-scope ready entry after the per-item loop. */
  readonly standDown?: (repoId: RepoId) => Promise<boolean>
}

export const defaultHaltDispatchDeps: HaltDispatchDeps = { applyItemAction: defaultApplyItemAction }

/** The one attached-agent or attached-session name a halt outcome reports — never a liveness
 *  claim, only what this app found on disk. An item with more than one attachment reports its first. */
function attachedAgentName(item: ReconciledItem): string | null {
  const agent = item.agents[0]
  if (agent !== undefined) return agent.stage ?? agent.agentType
  const session = item.sessions.find((s) => s.role === 'implement')
  return session !== undefined ? '/port:implement session' : null
}

/** Order is load-bearing: `runStates.set` runs first, and a failed write aborts the halt entirely.
 *  Every in-flight item is then visited sequentially; `standDown` runs last, once per ready entry. */
export async function haltDispatch(params: HaltDispatchParams, deps: HaltDispatchDeps = defaultHaltDispatchDeps): Promise<HaltReport> {
  const { snapshot, entries, runStates, repoIds, auditDir, now } = params
  const written = await runStates.set(repoIds, 'paused', now().toISOString())
  if (!written.ok) return { kind: 'aborted', reason: 'run-state-unwritable', message: written.message, path: runStates.path }

  const entryById = new Map(entries.map((entry) => [entry.id, entry] as const))
  const items: HaltItemOutcome[] = []

  for (const repoState of snapshot.state.repositories) {
    if (!repoState.ok) continue
    const entry = entryById.get(repoState.repoId)
    if (entry === undefined) continue

    for (const item of repoState.items) {
      if (item.stage !== 'in-flight') continue
      const inFlight = stageKeyOf(item)
      if (inFlight === null) continue

      if (item.sessionRequired) {
        items.push({ kind: 'skipped', number: item.number, itemKind: item.kind, repoId: repoState.repoId, reason: 'session-required', owner: null })
        continue
      }

      const availability = actionsFor({ item, viewer: repoState.viewer, approvalGate: repoState.approvalGate }).stop
      if (!availability.available) {
        if (availability.reason === 'not-owned') {
          items.push({ kind: 'skipped', number: item.number, itemKind: item.kind, repoId: repoState.repoId, reason: 'not-owned', owner: item.assignees[0] ?? null })
        } else if (availability.reason === 'viewer-unknown') {
          items.push({ kind: 'skipped', number: item.number, itemKind: item.kind, repoId: repoState.repoId, reason: 'viewer-unknown', owner: null })
        }
        // 'not-applicable' is never reachable here since 'in-flight' already guarantees stopPlan applies.
        continue
      }

      // This app's own per-item stop, before the label write, so the session is asked to stop first.
      const stoppedTask = (await deps.stopFor?.(repoState.repoId, item.number)) ?? false

      const result = await deps.applyItemAction({
        request: { repoId: repoState.repoId, kind: item.kind, number: item.number, action: 'stop', expectedStage: inFlight },
        snapshot,
        entry,
        auditDir,
      })

      if (result.ok && result.outcome.kind === 'applied') {
        const removedKey = availability.plan.remove[0] ?? inFlight
        const removedLabel = labelName(entry.config.vocabulary, removedKey) ?? removedKey
        items.push({ kind: 'stopped', number: item.number, itemKind: item.kind, repoId: repoState.repoId, removedLabel, attachedAgent: attachedAgentName(item), stoppedTask })
      } else {
        items.push({ kind: 'refused', number: item.number, itemKind: item.kind, repoId: repoState.repoId, result })
      }
    }
  }

  // This app's own whole-repository stand-down, after every item has been visited.
  for (const entry of entries) {
    await deps.standDown?.(entry.id)
  }

  return { kind: 'completed', items }
}
