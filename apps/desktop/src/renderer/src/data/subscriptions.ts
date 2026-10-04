// The renderer's one caller of a `window.port.on*` push listener (#316) —
// `main.ts` (board), `session/controller.ts` and `permission/controller.ts`
// all subscribe through this module instead of the bridge directly, so a
// pushed event is attached once no matter how many screens care about it.
// `session:event` is excluded by type (`SubscribableEvent`) and by
// `scripts/checks/desktop-react.ts` — it is the opaque SDK envelope #219's
// own projector exists to narrow, never consumed here.
import type { QueryClient } from '@tanstack/react-query'
import type { BridgeListener, IpcEvent, IpcEventMap } from '../../../shared/ipc'
import { ipcQueryOptions } from './query'

export type SubscribableEvent = Exclude<IpcEvent, 'session:event'>

type EventListener<E extends SubscribableEvent> = (payload: IpcEventMap[E]) => void

/** The narrow slice of `PortBridge` this module needs — a fake satisfying
 *  just these three listener methods is enough for a test, with no need to
 *  stub the rest of the bridge's dozens of invokers. The real `window.port`
 *  satisfies this structurally, carrying everything else besides. */
export type SubscriptionBridge = {
  [E in SubscribableEvent as BridgeListener<E>]: (listener: EventListener<E>) => () => void
}

export interface Subscriptions {
  subscribe<E extends SubscribableEvent>(event: E, listener: EventListener<E>): () => void
}

/** The one place `window.port.onBoardUpdate`/`onSessionStatus`/
 *  `onSessionEntries` are named (`scripts/checks/desktop-react.ts` pins
 *  their absence everywhere else under `renderer/`) — an explicit switch
 *  rather than the generic `bridgeListenerName` derivation, since there are
 *  only three subscribable events and a literal name here is what the check
 *  actually has something to find. */
function attachTo<E extends SubscribableEvent>(bridge: SubscriptionBridge, event: E, onPayload: (payload: IpcEventMap[E]) => void): () => void {
  if (event === 'board:update') return bridge.onBoardUpdate(onPayload as EventListener<'board:update'>)
  if (event === 'session:status') return bridge.onSessionStatus(onPayload as EventListener<'session:status'>)
  return bridge.onSessionEntries(onPayload as EventListener<'session:entries'>)
}

/** Attaches one bridge listener per event, lazily — the first `subscribe`
 *  call for an event attaches it, and detaching the last subscriber removes
 *  it, so an event nobody is currently watching costs nothing. */
export function createSubscriptions(bridge: SubscriptionBridge = window.port): Subscriptions {
  const fanouts = new Map<SubscribableEvent, Set<EventListener<never>>>()
  const detachers = new Map<SubscribableEvent, () => void>()

  function ensureAttached<E extends SubscribableEvent>(event: E): void {
    if (detachers.has(event)) return
    const detach = attachTo(bridge, event, (payload) => {
      for (const listener of fanouts.get(event) ?? []) (listener as EventListener<E>)(payload)
    })
    detachers.set(event, detach)
  }

  function detachIfIdle(event: SubscribableEvent): void {
    const set = fanouts.get(event)
    if (set !== undefined && set.size > 0) return
    detachers.get(event)?.()
    detachers.delete(event)
    fanouts.delete(event)
  }

  return {
    subscribe(event, listener) {
      ensureAttached(event)
      let set = fanouts.get(event)
      if (set === undefined) {
        set = new Set()
        fanouts.set(event, set)
      }
      set.add(listener)
      return () => {
        set.delete(listener)
        detachIfIdle(event)
      }
    },
  }
}

let shared: Subscriptions | null = null

/** The one app-wide instance — `main.ts`, `session/controller.ts` and
 *  `permission/controller.ts` all subscribe through this, never through a
 *  `createSubscriptions()` call of their own, so an event neither of them is
 *  first to need still attaches only once. Lazy, the same `themeStore()`
 *  idiom, so importing this module never touches `window` by itself. */
export function sharedSubscriptions(): Subscriptions {
  shared ??= createSubscriptions()
  return shared
}

/** Feeds `board:update` straight into the query cache so the legacy Board
 *  (and any future React consumer) reads one source of truth. Cancels any
 *  in-flight `board:snapshot` invoke first, so an older fetch resolving after
 *  a newer push can never clobber it. */
export function connectQueryCache(client: QueryClient, subscriptions: Subscriptions = sharedSubscriptions()): () => void {
  const key = ipcQueryOptions('board:snapshot').queryKey
  return subscriptions.subscribe('board:update', (snapshot) => {
    void client.cancelQueries({ queryKey: key })
    client.setQueryData(key, snapshot)
  })
}
