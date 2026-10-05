// The process-scoped dispatch ledger (#105) — this app's own analogue of
// the cockpit's session-scoped `.temp/dispatch-log.md`, in memory rather
// than on disk: a restarted app has an empty ledger, so every in-flight item
// reads `no-record` and is report-only, never a false reset. No timer, no
// filesystem — `main/state/watcher.ts` owns exactly one of each already.
import type { RepoId } from '../../shared/repos'
import type { LedgerRow, LedgerState, UnmatchedResult } from '../../../../../scripts/port-tick/liveness'
import { classifyUnmatched } from '../../../../../scripts/port-tick/liveness'
import type { RefreshMemoEntry } from '../../../../../scripts/port-tick/gates'

export interface DispatchLedger {
  /** #106's own call, once it actually dispatches — records the claim at
   *  `state: 'dispatched'`, carrying over any `resets` a prior row already
   *  had (a redispatch after a confirmed reset does not forgive a capped
   *  item, since nothing here ever clears `resets` back to zero). */
  readonly record: (repoId: RepoId, number: number) => void
  /** The low-level primitive `observeUnmatched` below is built from — writes
   *  the row forward only when `classifyUnmatched` returned a `nextState`
   *  (its `suspect`/`reset` classes); `no-record` and `capped` carry no
   *  `nextState` and leave the ledger untouched, exactly
   *  `scripts/port-tick.mjs`'s own orchestration. */
  readonly advance: (repoId: RepoId, number: number, result: UnmatchedResult) => void
  readonly rowFor: (repoId: RepoId, number: number) => LedgerRow | undefined
  /** #292: `plan.ts`'s own call for every unmatched in-flight claim, replacing
   *  its former `rowFor` + `classifyUnmatched` + `advance` call sequence.
   *  Classifies and advances the row **at most once per distinct `readAt`**
   *  (the GitHub read's own `fetchedAt`) — the UI polls roughly every 15s,
   *  far more often than a fresh GitHub read, and without this memo every
   *  poll would independently advance `dispatched` → `suspect` → `reset`,
   *  turning the cockpit's own two-tick debounce into roughly 30 seconds. A
   *  repeated snapshot over the same read returns the memoized result; a
   *  `null` `readAt` never advances and is never memoized, since the caller
   *  has nothing to key the memo on. */
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

/** The app's own equivalent of the cockpit's `tickState.unknownStreak`
 *  (#265) — a process-scoped `Map` keyed by `(repoId, number)`, counting how
 *  many consecutive ticks a pull request's mergeability has read `UNKNOWN`.
 *  No timer, no filesystem, same shape `createDispatchLedger` already
 *  establishes: an app restart starts every item back at 0, never a false
 *  hold. `get` defaults to 0 for an item never recorded. */
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

/** The app's own equivalent of the cockpit's `.temp/tick-state.json`
 *  `Refreshed:` record (#292) — a process-scoped `(repoId, number) → { sha,
 *  count }` map, the same lifetime and restart behaviour `createUnknownStreaks`
 *  already establishes: an app restart starts every pull request back at "no
 *  entry", never a false same-SHA escalation. */
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
