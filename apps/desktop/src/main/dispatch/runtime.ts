import type { UnknownStreaks, RefreshMemo, RerunMemo, ForceDispatch } from '@/types/tick'
import type { Dispatcher, AutoPlanner, CreateDispatcherParams, AutoPlannerDeps, DispatchActions } from '@/types/dispatch'
import type { PipelineWatcher } from '@/types/state'

// Bundles the dispatch loop's own process-lifetime state so main/ipc.ts creates one thing
// instead of wiring several by hand.
import { createForceDispatch, createRefreshMemo, createRerunMemo, createUnknownStreaks } from '@/main/pipeline/tick/ledger'

import type { RepoId } from '@/utils/repos'
import { createBudgetGate } from '@/main/dispatch/budget-gate'
import type { GitHubReadContext, LedgerWriteContext } from '@/main/github/context'
import { createDispatcher } from '@/main/dispatch/dispatcher'

import { createAutoPlanner } from '@/main/dispatch/auto-plan'

interface DispatchRuntime {
  readonly unknownStreaks: UnknownStreaks
  readonly refreshMemo: RefreshMemo
  readonly rerunMemo: RerunMemo
  readonly dispatcher: Dispatcher
  readonly forceDispatch: ForceDispatch
  /** The auto-plan swap's own snapshot consumer, gated on this app owning the repository. */
  readonly autoPlanner: AutoPlanner
  /** Called once, right after the watcher that owns `republish()` and `refresh()` is built. */
  readonly bindWatcher: (watcher: Pick<PipelineWatcher, 'republish' | 'refresh'>) => void
  /** Stops new launches and is called before `hostedStore.closeAll()` on quit. */
  readonly shutdown: () => void
}

type RuntimeDeps = Omit<CreateDispatcherParams, 'onChange' | 'budget' | 'escalate' | 'writeObservation' | 'rerunChecks' | 'rerunMemo' | 'stageLabels' | 'refreshMemo' | 'forceDispatch' | 'requestRead'> & { readonly actions: DispatchActions; readonly platform: GitHubReadContext & LedgerWriteContext }

export function createDispatchRuntime({ actions, platform, ...deps }: RuntimeDeps): DispatchRuntime {
  const unknownStreaks = createUnknownStreaks()
  const refreshMemo = createRefreshMemo()
  const rerunMemo = createRerunMemo()
  const forceDispatch = createForceDispatch()
  let bound: Pick<PipelineWatcher, 'republish' | 'refresh'> | null = null
  // A failed read is retried by the scheduled poll, so it is never surfaced here.
  const requestRead = (repoId: RepoId): void => void bound?.refresh({ repoId, source: 'github' }).catch(() => undefined)
  const dispatcher = createDispatcher({ ...deps, refreshMemo, rerunMemo, rerunChecks: actions.rerunChecks, forceDispatch, requestRead, budget: createBudgetGate({ scratchDir: deps.dirs.scratch, platform }), escalate: actions.escalateToHuman, writeObservation: actions.applyObservation, stageLabels: actions.stageLabels, onChange: () => bound?.republish() })
  const autoPlannerDeps: AutoPlannerDeps = {
    listRepositories: deps.listRepositories,
    registryDeps: deps.registryDeps,
    readOwnership: deps.readOwnership,
    runState: deps.runState,
    autoApprove: actions.autoApprovePlan,
    requestRead,
    onChange: () => bound?.republish(),
    auditDir: deps.dirs.audit,
    now: deps.now,
  }
  const autoPlanner = createAutoPlanner(autoPlannerDeps)
  return {
    unknownStreaks,
    refreshMemo,
    rerunMemo,
    dispatcher,
    forceDispatch,
    autoPlanner,
    bindWatcher: (watcher) => {
      bound = watcher
    },
    shutdown: () => dispatcher.shutdown(),
  }
}
