// #265: bundles the dispatcher's own process-lifetime state — the ledger,
// the mergeability-streak memo, the refresh memo (#292), and the dispatcher
// itself — so `main/ipc.ts` creates one thing instead of wiring several by
// hand. `bindWatcher` exists because the dispatcher's own `onChange` must
// call `watcher.republish()`, and the watcher cannot be built until after the
// dispatcher (it needs `dispatcher.status` for its own `dispatchStatus`).
// #293: also builds the budget gate and the escalation writer itself, so
// `main/ipc.ts` passes only `dirs` rather than wiring both by hand. #292:
// defaults `writeObservation` to `main/actions/observe.ts`'s own
// `applyObservation`, and exposes `watcherDeps` — the `ledger`/
// `unknownStreaks`/`refreshMemo`/`startedTasks`/`dispatchStatus` bundle
// `main/state/watcher.ts`'s own `createPipelineWatcher` spreads, in place of
// `main/ipc.ts` wiring each by hand (keeping that file at or under the
// 500-line limit).
import { createDispatchLedger, createRefreshMemo, createUnknownStreaks } from '../tick'
import type { DispatchLedger, RefreshMemo, UnknownStreaks } from '../tick'
import type { RepoId } from '../../shared/repos'
import type { RepoDispatchStatus } from '../../shared/dispatch/types'
import { applyObservation, escalateToHuman } from '../actions'
import { createBudgetGate } from './budget-gate'
import { createDispatcher } from './dispatcher'
import type { CreateDispatcherParams, Dispatcher } from './dispatcher'

export interface WatcherDeps {
  readonly ledger: DispatchLedger
  readonly unknownStreaks: UnknownStreaks
  readonly refreshMemo: RefreshMemo
  readonly startedTasks: (repoId: RepoId) => readonly string[]
  readonly dispatchStatus: () => readonly RepoDispatchStatus[]
}

export interface DispatchRuntime {
  readonly ledger: DispatchLedger
  readonly unknownStreaks: UnknownStreaks
  readonly refreshMemo: RefreshMemo
  readonly dispatcher: Dispatcher
  /** `main/state/watcher.ts`'s own `CreatePipelineWatcherParams` subset this
   *  runtime already owns — spread directly rather than wired field by field. */
  readonly watcherDeps: WatcherDeps
  /** Called once, right after the watcher that owns `republish()` is built. */
  readonly bindWatcher: (republish: () => void) => void
}

export function createDispatchRuntime(deps: Omit<CreateDispatcherParams, 'ledger' | 'onChange' | 'budget' | 'escalate' | 'writeObservation' | 'refreshMemo'>): DispatchRuntime {
  const ledger = createDispatchLedger()
  const unknownStreaks = createUnknownStreaks()
  const refreshMemo = createRefreshMemo()
  let republishFn: (() => void) | null = null
  const dispatcher = createDispatcher({ ...deps, ledger, refreshMemo, budget: createBudgetGate(), escalate: escalateToHuman, writeObservation: applyObservation, onChange: () => republishFn?.() })
  return {
    ledger,
    unknownStreaks,
    refreshMemo,
    dispatcher,
    watcherDeps: {
      ledger,
      unknownStreaks,
      refreshMemo,
      startedTasks: (repoId) => dispatcher.startedTasks(repoId),
      dispatchStatus: () => dispatcher.status(),
    },
    bindWatcher: (republish) => {
      republishFn = republish
    },
  }
}
