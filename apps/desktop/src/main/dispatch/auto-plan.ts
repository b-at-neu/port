// Honours the cockpit's unprompted `autoPlan` swap while this app owns the repository.
import type { BoardSnapshot } from '@/types/board'
import type { RepoId } from '@/utils/repos'
import type { ReadyEntry } from '@/types/actions'
import { stateMoved } from '@/types/writes'
import { autoApprovalCandidatesFrom } from '@/main/pipeline/tick/dispatchable'
import { autoPlanSwapCandidatesOf } from '@/main/pipeline/tick/auto-plan'
import { autoApprovePlan } from '@/main/pipeline/operator/gate'
import { readOwnership } from '@/main/repos/ownership'
import { isReadyEntry } from '@/main/repos'
import { requestRead } from '@/main/dispatch/context'
import type { AutoPlanContext } from '@/main/dispatch/context'
import type { AutoPlanner } from '@/types/dispatch'

export function createAutoPlanner(ctx: AutoPlanContext): AutoPlanner {
  const inFlight = new Set<RepoId>()
  // `(repoId, number) -> at` the last write attempted, so a stale snapshot never re-fires it.
  const attemptedAt = new Map<RepoId, Map<number, string>>()
  // Numbers whose last swap did not land; the board shows them as waiting on the operator.
  const refusedBy = new Map<RepoId, Set<number>>()

  function attempted(repoId: RepoId): Map<number, string> {
    const existing = attemptedAt.get(repoId)
    if (existing !== undefined) return existing
    const created = new Map<number, string>()
    attemptedAt.set(repoId, created)
    return created
  }

  function refusedSet(repoId: RepoId): Set<number> {
    const existing = refusedBy.get(repoId)
    if (existing !== undefined) return existing
    const created = new Set<number>()
    refusedBy.set(repoId, created)
    return created
  }

  async function considerRepo(entry: ReadyEntry, snapshot: BoardSnapshot): Promise<void> {
    if (inFlight.has(entry.id)) return
    inFlight.add(entry.id)
    let changed = false
    try {
      const refused = refusedSet(entry.id)
      const tick = snapshot.tick.find((t) => t.repoId === entry.id)
      if (tick !== undefined && tick.blind === null) {
        const live = new Set(autoApprovalCandidatesFrom(tick).map((candidate) => candidate.number))
        for (const number of refused) {
          if (live.has(number)) continue
          refused.delete(number)
          changed = true
        }
      }

      const ownership = await readOwnership(ctx, { repoRoot: entry.path, repo: entry.config.repo })
      if (ownership.kind !== 'app') return

      if (tick === undefined) return
      const candidates = autoPlanSwapCandidatesOf({ report: tick, owner: 'app', runState: ctx.stores.runStates.current(entry.id).state })
      if (candidates.length === 0) return

      const repoState = snapshot.state.repositories.find((r) => r.ok && r.repoId === entry.id)
      if (repoState === undefined || !repoState.ok) return
      const fetchedAt = 'at' in repoState.freshness.github ? repoState.freshness.github.at : null
      const itemsByNumber = new Map(repoState.items.map((item) => [item.number, item] as const))
      const writeAt = attempted(entry.id)

      let applied = 0
      for (const number of candidates) {
        const lastAttempt = writeAt.get(number)
        if (fetchedAt !== null && lastAttempt !== undefined && lastAttempt >= fetchedAt) continue

        const item = itemsByNumber.get(number)
        if (item === undefined) continue

        const at = ctx.clock.now().toISOString()
        let landed = false
        try {
          const outcome = await autoApprovePlan(ctx, { entry, item: { number, assignees: item.assignees }, auditDir: ctx.paths.userData })
          if (outcome.kind === 'applied' || outcome.kind === 'mirror-failed') applied += 1
          landed = stateMoved(outcome)
        } catch {
          // Swallowed; reattempted on the next fresher GitHub read, never surfaced as an error.
        }
        writeAt.set(number, at)
        if (landed && refused.delete(number)) changed = true
        if (!landed && !refused.has(number)) {
          refused.add(number)
          changed = true
        }
      }
      if (applied > 0) requestRead(ctx, entry.id)
    } finally {
      inFlight.delete(entry.id)
      if (changed) ctx.live.watcher.republish()
    }
  }

  async function consider(snapshot: BoardSnapshot): Promise<void> {
    const list = await ctx.repos.list()
    if (!list.ok) return
    const readyEntries = list.repositories.filter(isReadyEntry)
    await Promise.all(readyEntries.map((entry) => considerRepo(entry, snapshot)))
  }

  return { consider, refused: (repoId) => refusedBy.get(repoId) ?? new Set<number>() }
}
