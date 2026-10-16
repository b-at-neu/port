import type { DispatchLedger, UnknownStreaks, RefreshMemo, ForceDispatch } from '@/types/tick'
import type { Dispatcher, AutoPlanner, CreateDispatcherParams, AutoPlannerDeps } from '@/types/dispatch'

// Bundles the dispatch loop's own process-lifetime state so main/ipc.ts creates one thing
// instead of wiring several by hand.
import { createDispatchLedger, createForceDispatch, createRefreshMemo, createUnknownStreaks } from '@/main/tick/ledger'

import type { RepoId } from '@/utils/repos'
import type { RepoDispatchStatus } from '@/types/dispatch'
import { applyObservation } from '@/main/actions/observe'
import { autoApprovePlan } from '@/main/actions/gate'
import { escalateToHuman } from '@/main/actions/escalate'
import { createBudgetGate } from '@/main/dispatch/budget-gate'
import { createDispatcher } from '@/main/dispatch/dispatcher'

import { createAutoPlanner } from '@/main/dispatch/auto-plan'

import type { EndedStage } from '@/types/tick'

interface WatcherDeps {
  readonly ledger: DispatchLedger
  readonly unknownStreaks: UnknownStreaks
  readonly refreshMemo: RefreshMemo
  readonly forceDispatch: ForceDispatch
  readonly startedTasks: (repoId: RepoId) => readonly string[]
  readonly dispatchStatus: () => readonly RepoDispatchStatus[]
  readonly holdSessionRequired: (repoId: RepoId) => boolean
  readonly stageLiveness: (repoId: RepoId) => { readonly live: readonly string[]; readonly interrupted: readonly string[] } | null
  readonly endedStages: (repoId: RepoId) => readonly EndedStage[]
}

interface DispatchRuntime {
  readonly ledger: DispatchLedger
  readonly unknownStreaks: UnknownStreaks
  readonly refreshMemo: RefreshMemo
  readonly dispatcher: Dispatcher
  readonly forceDispatch: ForceDispatch
  /** The auto-plan swap's own snapshot consumer, gated on this app owning the repository. */
  readonly autoPlanner: AutoPlanner
  readonly watcherDeps: WatcherDeps
  /** Called once, right after the watcher that owns `republish()` is built. */
  readonly bindWatcher: (republish: () => void) => void
  /** Stops new launches and is called before `hostedStore.closeAll()` on quit. */
  readonly shutdown: () => void
}

export function createDispatchRuntime(deps: Omit<CreateDispatcherParams, 'ledger' | 'onChange' | 'budget' | 'escalate' | 'writeObservation' | 'refreshMemo' | 'forceDispatch'>): DispatchRuntime {
  const ledger = createDispatchLedger()
  const unknownStreaks = createUnknownStreaks()
  const refreshMemo = createRefreshMemo()
  const forceDispatch = createForceDispatch()
  let republishFn: (() => void) | null = null
  const dispatcher = createDispatcher({ ...deps, ledger, refreshMemo, forceDispatch, budget: createBudgetGate(), escalate: escalateToHuman, writeObservation: applyObservation, onChange: () => republishFn?.() })
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
    forceDispatch,
    autoPlanner,
    watcherDeps: {
      ledger,
      unknownStreaks,
      refreshMemo,
      forceDispatch,
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
