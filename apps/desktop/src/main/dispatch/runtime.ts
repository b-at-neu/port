// #326: bundles the dispatch loop's own process-lifetime state — the
// ledger, the refresh memo, and the loop itself — so `main/ipc.ts` creates
// one thing instead of wiring several by hand. `bindWatcher` exists because
// the loop's own `onChange` must call `watcher.republish()`, and the watcher
// cannot be built until after the loop (it needs `dispatcher.liveStages` for
// its own `watcherDeps`). Also builds the budget gate and the escalation
// writer itself, so `main/ipc.ts` passes only `dirs` rather than wiring both
// by hand, and exposes `watcherDeps` and `shutdown`.
import { createDispatchLedger, createRefreshMemo, createUnknownStreaks } from '../tick/ledger'
import type { DispatchLedger, RefreshMemo, UnknownStreaks } from '../tick/ledger'
import type { RepoId } from '../../shared/repos'
import type { RepoDispatchStatus } from '../../shared/dispatch/types'
import { applyObservation } from '../actions/observe'
import { autoApprovePlan } from '../actions/gate'
import { escalateToHuman } from '../actions/escalate'
import { createBudgetGate } from './budget-gate'
import { createDispatcher } from './dispatcher'
import type { CreateDispatcherParams, Dispatcher } from './dispatcher'
import { createAutoPlanner } from './auto-plan'
import type { AutoPlanner, AutoPlannerDeps } from './auto-plan'

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
  /** #313: the auto-plan swap's own snapshot consumer — built from the same
   *  deps as `dispatcher`, gated on `plan-gate` rather than `dispatch`. */
  readonly autoPlanner: AutoPlanner
  /** `main/state/watcher.ts`'s own `CreatePipelineWatcherParams` subset this
   *  runtime already owns — spread directly rather than wired field by field. */
  readonly watcherDeps: WatcherDeps
  /** Called once, right after the watcher that owns `republish()` is built. */
  readonly bindWatcher: (republish: () => void) => void
  /** Stops new launches and is called before `hostedStore.closeAll()` on
   *  quit — `main/index.ts`'s own quit guard. */
  readonly shutdown: () => void
}

export function createDispatchRuntime(deps: Omit<CreateDispatcherParams, 'ledger' | 'onChange' | 'budget' | 'escalate' | 'writeObservation' | 'refreshMemo'>): DispatchRuntime {
  const ledger = createDispatchLedger()
  const unknownStreaks = createUnknownStreaks()
  const refreshMemo = createRefreshMemo()
  let republishFn: (() => void) | null = null
  const dispatcher = createDispatcher({ ...deps, ledger, refreshMemo, budget: createBudgetGate(), escalate: escalateToHuman, writeObservation: applyObservation, onChange: () => republishFn?.() })
  const autoPlannerDeps: AutoPlannerDeps = {
    listRepositories: deps.listRepositories,
    registryDeps: deps.registryDeps,
    readOwnership: deps.readOwnership,
    runState: deps.runState,
    autoApprove: autoApprovePlan,
    auditDir: deps.dirs.audit,
    now: deps.now,
  }
  const autoPlanner = createAutoPlanner(autoPlannerDeps)
  return {
    ledger,
    unknownStreaks,
    refreshMemo,
    dispatcher,
    autoPlanner,
    watcherDeps: {
      ledger,
      unknownStreaks,
      refreshMemo,
      startedTasks: (repoId) => dispatcher.liveStages(repoId),
      dispatchStatus: () => dispatcher.status(),
    },
    bindWatcher: (republish) => {
      republishFn = republish
    },
    shutdown: () => dispatcher.shutdown(),
  }
}
