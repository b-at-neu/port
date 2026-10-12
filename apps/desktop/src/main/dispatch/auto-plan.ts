// Honours the cockpit's unprompted `autoPlan` swap while this app owns the repository.
import type { BoardSnapshot } from '@/types/board'
import type { RepoId } from '@/utils/repos'
import type {ReadyEntry} from '@/types/actions'
import { autoApprovableFrom } from '@/main/tick/dispatchable'


import type { AutoPlanner, AutoPlannerDeps } from '@/types/dispatch'

export function createAutoPlanner(deps: AutoPlannerDeps): AutoPlanner {
  const inFlight = new Set<RepoId>()
  // `(repoId, number) -> at` the last write attempted, so a stale snapshot never re-fires it.
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
      const ownership = await deps.readOwnership({ repoRoot: entry.path, repo: entry.config.repo, now: deps.now })
      if (ownership.kind !== 'app') return

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
          // Swallowed; reattempted on the next fresher GitHub read, never surfaced to the operator.
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
