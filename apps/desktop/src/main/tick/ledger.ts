// The process-scoped dispatch ledger: this app's own analogue of the cockpit's session-scoped
// dispatch log, in memory rather than on disk. A restarted app has an empty ledger, never a false reset.
import type { RepoId } from '../../shared/repos'
import type { LedgerRow, LedgerState, UnmatchedResult } from '../../../../../scripts/port-tick/liveness'
import { classifyUnmatched } from '../../../../../scripts/port-tick/liveness'
import type { RefreshMemoEntry } from '../../../../../scripts/port-tick/gates'

export interface DispatchLedger {
  /** Records the claim at `state: 'dispatched'`, carrying over any `resets` a prior row already had. */
  readonly record: (repoId: RepoId, number: number) => void
  /** Writes the row forward only when `classifyUnmatched` returned a `nextState`; `no-record` and
   *  `capped` leave the ledger untouched. */
  readonly advance: (repoId: RepoId, number: number, result: UnmatchedResult) => void
  readonly rowFor: (repoId: RepoId, number: number) => LedgerRow | undefined
  /** Classifies and advances the row at most once per distinct `readAt`, so repeated polls over
   *  the same GitHub read don't independently advance the state past the intended debounce. */
  readonly observeUnmatched: (repoId: RepoId, number: number, readAt: string | null) => UnmatchedResult
}

export function createDispatchLedger(): DispatchLedger {
  const rows = new Map<RepoId, Map<number, LedgerRow>>()
  const observedAt = new Map<RepoId, Map<number, { readonly readAt: string; readonly result: UnmatchedResult }>>()

  function bucket(repoId: RepoId): Map<number, LedgerRow> {
    const existing = rows.get(repoId)
    if (existing) return existing
    const created = new Map<number, LedgerRow>()
    rows.set(repoId, created)
    return created
  }

  function observedBucket(repoId: RepoId): Map<number, { readonly readAt: string; readonly result: UnmatchedResult }> {
    const existing = observedAt.get(repoId)
    if (existing) return existing
    const created = new Map<number, { readonly readAt: string; readonly result: UnmatchedResult }>()
    observedAt.set(repoId, created)
    return created
  }

  function advance(repoId: RepoId, number: number, result: UnmatchedResult): void {
    if (result.nextState === undefined) return
    bucket(repoId).set(number, { state: result.nextState, resets: result.nextResets ?? 0 })
  }

  return {
    record(repoId, number) {
      const prior = bucket(repoId).get(number)
      const dispatched: LedgerState = 'dispatched'
      bucket(repoId).set(number, { state: dispatched, resets: prior?.resets ?? 0 })
    },
    advance,
    rowFor(repoId, number) {
      return rows.get(repoId)?.get(number)
    },
    observeUnmatched(repoId, number, readAt) {
      if (readAt === null) return classifyUnmatched(bucket(repoId).get(number))
      const memo = observedBucket(repoId).get(number)
      if (memo !== undefined && memo.readAt === readAt) return memo.result
      const result = classifyUnmatched(bucket(repoId).get(number))
      advance(repoId, number, result)
      observedBucket(repoId).set(number, { readAt, result })
      return result
    },
  }
}

export interface UnknownStreaks {
  readonly get: (repoId: RepoId, number: number) => number
  readonly set: (repoId: RepoId, number: number, streak: number) => void
  readonly clear: (repoId: RepoId, number: number) => void
}

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

export interface RefreshMemo {
  readonly get: (repoId: RepoId, number: number) => RefreshMemoEntry | undefined
  readonly set: (repoId: RepoId, number: number, entry: RefreshMemoEntry) => void
  readonly clear: (repoId: RepoId, number: number) => void
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
