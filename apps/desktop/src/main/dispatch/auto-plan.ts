// #313: the auto-plan swap's own snapshot consumer — honours the cockpit's
// unprompted `autoPlan` swap while this app holds the `plan-gate` claim
// instead of `dispatch`. `main/ipc.ts`'s `onSnapshot` is the one caller,
// mirroring the dispatcher's own `onTick` wiring but gated on a different
// claim scope: the planner needs only `plan-gate`, never `dispatch`, so it
// lives beside the dispatcher rather than inside it.
import type { BoardSnapshot } from '../../shared/board/types'
import type { RunState } from '../../shared/dispatch/types'
import type { RepoId } from '../../shared/repos'
import type { ReadyEntry } from '../actions'
import type { AutoApprovePlanParams } from '../actions'
import { autoApprovableFrom } from '../tick'
import type { RegistryDeps } from '../registry'
import { listRepositories as defaultListRepositories } from '../registry'
import type { ReadGateClaimParams } from '../writes'
import type { ClaimRead } from '../../shared/writes/types'
import type { WriteOutcome } from '../../shared/writes/types'

export interface AutoPlannerDeps {
  readonly listRepositories: typeof defaultListRepositories
  readonly registryDeps: RegistryDeps
  readonly readGateClaim: (params: ReadGateClaimParams) => Promise<ClaimRead>
  /** This repository's own persisted run state — the same per-repository
   *  source `main/dispatch/dispatcher.ts`'s own `CreateDispatcherParams.runState`
   *  reads, never a second store. */
  readonly runState: (repoId: RepoId) => RunState
  readonly autoApprove: (params: AutoApprovePlanParams) => Promise<WriteOutcome>
  readonly auditDir: string
  readonly now: () => Date
}

export interface AutoPlanner {
  consider(snapshot: BoardSnapshot): Promise<void>
}

export function createAutoPlanner(deps: AutoPlannerDeps): AutoPlanner {
  const inFlight = new Set<RepoId>()
  // `(repoId, number) -> at` the last write this process attempted, so a
  // snapshot the GitHub read has not caught up to yet never re-fires the
  // same write — the same guard `observe-pass.ts` uses for the four
  // machine-observation families.
  const attemptedAt = new Map<RepoId, Map<number, string>>()

  function attempted(repoId: RepoId): Map<number, string> {
    const existing = attemptedAt.get(repoId)
    if (existing !== undefined) return existing
    const created = new Map<number, string>()
    attemptedAt.set(repoId, created)
    return created
  }

  async function considerRepo(entry: ReadyEntry, snapshot: BoardSnapshot): Promise<void> {
    if (inFlight.has(entry.id)) return
    inFlight.add(entry.id)
    try {
      const claim = await deps.readGateClaim({ repoRoot: entry.path, repo: entry.config.repo, now: deps.now })
      if (claim.state !== 'held' || !claim.scopes.includes('plan-gate')) return

      const tick = snapshot.tick.find((t) => t.repoId === entry.id)
      if (tick === undefined) return
      const candidates = autoApprovableFrom(tick, deps.runState(entry.id))
      if (candidates.length === 0) return

      const repoState = snapshot.state.repositories.find((r) => r.ok && r.repoId === entry.id)
      if (repoState === undefined || !repoState.ok) return
      const fetchedAt = 'at' in repoState.freshness.github ? repoState.freshness.github.at : null
      const itemsByNumber = new Map(repoState.items.map((item) => [item.number, item] as const))
      const writeAt = attempted(entry.id)

      for (const candidate of candidates) {
        const lastAttempt = writeAt.get(candidate.number)
        if (fetchedAt !== null && lastAttempt !== undefined && lastAttempt >= fetchedAt) continue

        const item = itemsByNumber.get(candidate.number)
        if (item === undefined) continue

        const at = deps.now().toISOString()
        try {
          await deps.autoApprove({ entry, item: { number: candidate.number, assignees: item.assignees }, auditDir: deps.auditDir })
        } catch {
          // Swallowed, like `observe-pass.ts`'s own write attempts — a throw
          // here is reattempted on the next fresher GitHub read, never
          // surfaced as a toast or dialog, since the operator did not start
          // this write.
        }
        writeAt.set(candidate.number, at)
      }
    } finally {
      inFlight.delete(entry.id)
    }
  }

  async function consider(snapshot: BoardSnapshot): Promise<void> {
    const list = await deps.listRepositories(deps.registryDeps)
    if (!list.ok) return
    const readyEntries = list.repositories.filter((e): e is ReadyEntry => 'config' in e)
    await Promise.all(readyEntries.map((entry) => considerRepo(entry, snapshot)))
  }

  return { consider }
}
