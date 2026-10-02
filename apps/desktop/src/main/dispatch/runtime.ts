// #265: bundles the dispatcher's own process-lifetime state — the ledger,
// the mergeability-streak memo, and the dispatcher itself — so `main/ipc.ts`
// creates one thing instead of wiring four by hand. `bindWatcher` exists
// because the dispatcher's own `onChange` must call `watcher.republish()`,
// and the watcher cannot be built until after the dispatcher (it needs
// `dispatcher.status` for its own `dispatchStatus`). #293: also builds the
// budget gate and the escalation writer itself, so `main/ipc.ts` passes only
// `dirs` rather than wiring both by hand.
import { createDispatchLedger, createUnknownStreaks } from '../tick'
import type { DispatchLedger, UnknownStreaks } from '../tick'
import { escalateToHuman } from '../actions'
import { createBudgetGate } from './budget-gate'
import { createDispatcher } from './dispatcher'
import type { CreateDispatcherParams, Dispatcher } from './dispatcher'

export interface DispatchRuntime {
  readonly ledger: DispatchLedger
  readonly unknownStreaks: UnknownStreaks
  readonly dispatcher: Dispatcher
  /** Called once, right after the watcher that owns `republish()` is built. */
  readonly bindWatcher: (republish: () => void) => void
}

export function createDispatchRuntime(deps: Omit<CreateDispatcherParams, 'ledger' | 'onChange' | 'budget' | 'escalate'>): DispatchRuntime {
  const ledger = createDispatchLedger()
  const unknownStreaks = createUnknownStreaks()
  let republishFn: (() => void) | null = null
  const dispatcher = createDispatcher({ ...deps, ledger, budget: createBudgetGate(), escalate: escalateToHuman, onChange: () => republishFn?.() })
  return {
    ledger,
    unknownStreaks,
    dispatcher,
    bindWatcher: (republish) => {
      republishFn = republish
    },
  }
}
