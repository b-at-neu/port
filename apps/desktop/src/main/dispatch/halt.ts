// Pause-then-stop-every-claim (#110, #314) — the composition `resolveDispatchControl`
// calls for the `pause` command (scoped to one repository) and for `halt`
// (every registered repository). Never `applyLabels` directly: every write
// goes through `applyItemAction` (`../actions`), the same chokepoint the
// board's own row buttons use, so ownership, the stage-drift check, and the
// audit log all apply unchanged.
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
  /** The ready entries in scope — one repository for `pause`, every ready
   *  repository for `halt`. Used to resolve each item's own label
   *  vocabulary; an entry missing for a repository means every item there is
   *  skipped, never stopped. */
  readonly entries: readonly ReadyEntry[]
  readonly runStates: RunStateStore
  /** The repository ids to pause — written to `runStates` first, regardless
   *  of whether `entries` carries a ready entry for every one of them (a
   *  not-ready repository can still hold a run state; it simply has no
   *  in-flight items to stop). */
  readonly repoIds: readonly RepoId[]
  readonly auditDir: string
  readonly now: () => Date
}

export interface HaltDispatchDeps {
  readonly applyItemAction: (params: ApplyItemActionParams) => Promise<ItemActionResult>
  /** #326: this app's own per-item stop — closes an app-launched stage
   *  session, called before every `applyItemAction`, same order as the
   *  run-state write before it, so the session is asked to stop before its
   *  label is ever touched. A no-op default (`undefined`) for every caller
   *  that has no dispatch loop at all. */
  readonly stopFor?: (repoId: RepoId, number: number) => Promise<boolean>
  /** #326: this app's own whole-repository stand-down, called once per
   *  in-scope ready entry after the per-item loop — closes every remaining
   *  live stage session `stopFor` did not already reach. */
  readonly standDown?: (repoId: RepoId) => Promise<boolean>
}

export const defaultHaltDispatchDeps: HaltDispatchDeps = { applyItemAction: defaultApplyItemAction }

/** The one attached-agent or attached-session name a halt outcome reports —
 *  never a liveness claim, only what this app found on disk (ENGINEERING
 *  §4's own rule for every attachment signal in the app). An item with more
 *  than one attachment reports its first, the same priority `board/rows.ts`'s
 *  own `agentSummaryOf` already uses. */
function attachedAgentName(item: ReconciledItem): string | null {
  const agent = item.agents[0]
  if (agent !== undefined) return agent.stage ?? agent.agentType
  const session = item.sessions.find((s) => s.role === 'implement')
  return session !== undefined ? '/port:implement session' : null
}

/**
 * Order is load-bearing: `runStates.set(repoIds, 'paused', …)` runs first,
 * and a failed write aborts the halt entirely — resetting labels while
 * dispatch might still resume on its own would only re-dispatch everything
 * this call was meant to stop. Every in-flight item across every in-scope
 * repository is then visited sequentially (never parallel `gh` writes
 * against one repository): session-required items and ownership refusals
 * are skipped and reported without ever calling `applyItemAction`;
 * everything else goes through it with `action: 'stop'`, and its result —
 * applied, or any other `ItemActionResult` — is carried into the report
 * unchanged. `standDown` runs once per in-scope ready entry, after every
 * item has been visited.
 */
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
        // 'not-applicable' is never reachable here — `item.stage ===
        // 'in-flight'` already guarantees `stopPlan` applies.
        continue
      }

      // #326: this app's own per-item stop, before the label write — same
      // order as the run-state write before the loop, so an app-launched
      // stage session is asked to stop before its label is ever touched.
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

  // #326: this app's own whole-repository stand-down, once per in-scope
  // ready entry, after every item has been visited — `stopFor` above needs
  // the live session, so this must run after, never interleaved with it.
  for (const entry of entries) {
    await deps.standDown?.(entry.id)
  }

  return { kind: 'completed', items }
}
