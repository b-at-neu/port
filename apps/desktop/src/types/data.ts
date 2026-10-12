// Shared view-model and bridge-subscription types for renderer/data/ — multi-file or test-only.
import type { BridgeListener, IpcEvent, IpcEventMap } from '@/types/ipc'

export type SubscribableEvent = IpcEvent

export type EventListener<E extends SubscribableEvent> = (payload: IpcEventMap[E]) => void

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
