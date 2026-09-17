// The process-scoped dispatch ledger (#105) — this app's own analogue of
// the cockpit's session-scoped `.temp/dispatch-log.md`, in memory rather
// than on disk: a restarted app has an empty ledger, so every in-flight item
// reads `no-record` and is report-only, never a false reset. No timer, no
// filesystem — `main/state/watcher.ts` owns exactly one of each already.
import type { RepoId } from '../../shared/repos'
import type { LedgerRow, LedgerState, UnmatchedResult } from './liveness'

export interface DispatchLedger {
  /** #106's own call, once it actually dispatches — records the claim at
   *  `state: 'dispatched'`, carrying over any `resets` a prior row already
   *  had (a redispatch after a confirmed reset does not forgive a capped
   *  item, since nothing here ever clears `resets` back to zero). */
  readonly record: (repoId: RepoId, number: number) => void
  /** `plan.ts`'s own call for every unmatched in-flight claim it classifies
   *  — writes the row forward only when `classifyUnmatched` returned a
   *  `nextState` (its `suspect`/`reset` classes); `no-record` and `capped`
   *  carry no `nextState` and leave the ledger untouched, exactly
   *  `scripts/port-tick.mjs`'s own orchestration. */
  readonly advance: (repoId: RepoId, number: number, result: UnmatchedResult) => void
  readonly rowFor: (repoId: RepoId, number: number) => LedgerRow | undefined
}

export function createDispatchLedger(): DispatchLedger {
  const rows = new Map<RepoId, Map<number, LedgerRow>>()

  function bucket(repoId: RepoId): Map<number, LedgerRow> {
    const existing = rows.get(repoId)
    if (existing) return existing
    const created = new Map<number, LedgerRow>()
    rows.set(repoId, created)
    return created
  }

  return {
    record(repoId, number) {
      const prior = bucket(repoId).get(number)
      const dispatched: LedgerState = 'dispatched'
      bucket(repoId).set(number, { state: dispatched, resets: prior?.resets ?? 0 })
    },
    advance(repoId, number, result) {
      if (result.nextState === undefined) return
      bucket(repoId).set(number, { state: result.nextState, resets: result.nextResets ?? 0 })
    },
    rowFor(repoId, number) {
      return rows.get(repoId)?.get(number)
    },
  }
}
