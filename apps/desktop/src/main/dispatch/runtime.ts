// Bundles the dispatch loop's own process-lifetime state so main/ipc.ts creates one thing
// instead of wiring several by hand.
import { createDispatchLedger, createRefreshMemo, createUnknownStreaks } from '@/main/tick/ledger'
import type { DispatchLedger, RefreshMemo, UnknownStreaks } from '@/main/tick/ledger'
import type { RepoId } from '@/utils/repos'
import type { RepoDispatchStatus } from '@/types/dispatch'
import { applyObservation } from '@/main/actions/observe'
import { autoApprovePlan } from '@/main/actions/gate'
import { escalateToHuman } from '@/main/actions/escalate'
import { createBudgetGate } from '@/main/dispatch/budget-gate'
import { createDispatcher } from '@/main/dispatch/dispatcher'
import type { CreateDispatcherParams, Dispatcher } from '@/main/dispatch/dispatcher'
import { createAutoPlanner } from '@/main/dispatch/auto-plan'
import type { AutoPlanner, AutoPlannerDeps } from '@/main/dispatch/auto-plan'
import type { EndedStage } from '@/types/tick'

export interface WatcherDeps {
  readonly ledger: DispatchLedger
  readonly unknownStreaks: UnknownStreaks
  readonly refreshMemo: RefreshMemo
  readonly startedTasks: (repoId: RepoId) => readonly string[]
  readonly dispatchStatus: () => readonly RepoDispatchStatus[]
  readonly holdSessionRequired: (repoId: RepoId) => boolean
  readonly stageLiveness: (repoId: RepoId) => { readonly live: readonly string[]; readonly interrupted: readonly string[] } | null
  readonly endedStages: (repoId: RepoId) => readonly EndedStage[]
}

export interface DispatchRuntime {
  readonly ledger: DispatchLedger
  readonly unknownStreaks: UnknownStreaks
  readonly refreshMemo: RefreshMemo
  readonly dispatcher: Dispatcher
  /** The auto-plan swap's own snapshot consumer, gated on this app owning the repository. */
  readonly autoPlanner: AutoPlanner
  readonly watcherDeps: WatcherDeps
  /** Called once, right after the watcher that owns `republish()` is built. */
  readonly bindWatcher: (republish: () => void) => void
  /** Stops new launches and is called before `hostedStore.closeAll()` on quit. */
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
      holdSessionRequired: (repoId) => dispatcher.holdsSessionRequired(repoId),
      stageLiveness: (repoId) => dispatcher.stageLiveness(repoId),
      endedStages: (repoId) => dispatcher.endedStages(repoId),
    },
    bindWatcher: (republish) => {
      republishFn = republish
    },
    shutdown: () => dispatcher.shutdown(),
  }
}
