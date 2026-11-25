// The process-scoped memos of the tick: each starts empty after a restart.
import type { RepoId } from '@/utils/repos'
import type { RefreshMemoEntry } from '@/utils/pipeline/gates'
import type { RefreshMemo, RerunMemo, UnknownStreaks, ForceDispatch } from '@/types/tick'

/** The app's own equivalent of the cockpit's `tickState.unknownStreak` — a process-scoped map
 *  counting consecutive UNKNOWN mergeability ticks. `get` defaults to 0 for an item never recorded. */
export function createUnknownStreaks(): UnknownStreaks {
  const rows = new Map<RepoId, Map<number, number>>()

  function bucket(repoId: RepoId): Map<number, number> {
    const existing = rows.get(repoId)
    if (existing) return existing
    const created = new Map<number, number>()
    rows.set(repoId, created)
    return created
  }

  return {
    get(repoId, number) {
      return bucket(repoId).get(number) ?? 0
    },
    set(repoId, number, streak) {
      bucket(repoId).set(number, streak)
    },
    clear(repoId, number) {
      bucket(repoId).delete(number)
    },
  }
}

/** The app's own equivalent of the cockpit's `Refreshed:` record — a process-scoped map, same
 *  restart behaviour as `createUnknownStreaks`: every pull request starts back at "no entry". */
export function createRefreshMemo(): RefreshMemo {
  const rows = new Map<RepoId, Map<number, RefreshMemoEntry>>()

  function bucket(repoId: RepoId): Map<number, RefreshMemoEntry> {
    const existing = rows.get(repoId)
    if (existing) return existing
    const created = new Map<number, RefreshMemoEntry>()
    rows.set(repoId, created)
    return created
  }

  return {
    get(repoId, number) {
      return bucket(repoId).get(number)
    },
    set(repoId, number, entry) {
      bucket(repoId).set(number, entry)
    },
    clear(repoId, number) {
      bucket(repoId).delete(number)
    },
  }
}

/** The head a pull request's failed checks were last re-run on — a process-scoped map, same restart behaviour as `createRefreshMemo`. */
export function createRerunMemo(): RerunMemo {
  const rows = new Map<RepoId, Map<number, string>>()

  function bucket(repoId: RepoId): Map<number, string> {
    const existing = rows.get(repoId)
    if (existing) return existing
    const created = new Map<number, string>()
    rows.set(repoId, created)
    return created
  }

  return {
    get(repoId, number) {
      return bucket(repoId).get(number)
    },
    set(repoId, number, headRefOid) {
      bucket(repoId).set(number, headRefOid)
    },
  }
}

/** The Needs-you "Dispatch anyway" override's own storage — same per-repository `Set<number>`
 *  shape and restart behaviour as `createUnknownStreaks`. */
export function createForceDispatch(): ForceDispatch {
  const rows = new Map<RepoId, Set<number>>()

  function bucket(repoId: RepoId): Set<number> {
    const existing = rows.get(repoId)
    if (existing) return existing
    const created = new Set<number>()
    rows.set(repoId, created)
    return created
  }

  return {
    has(repoId, number) {
      return bucket(repoId).has(number)
    },
    set(repoId, number) {
      bucket(repoId).add(number)
    },
    clear(repoId, number) {
      bucket(repoId).delete(number)
    },
    prune(repoId, keep) {
      const set = rows.get(repoId)
      if (set === undefined) return
      for (const number of set) {
        if (!keep.has(number)) set.delete(number)
      }
    },
  }
}
