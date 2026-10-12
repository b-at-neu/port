// Shared view-model and bridge-subscription types for renderer/data/ — multi-file or test-only.
import type { BridgeListener, IpcEvent, IpcEventMap } from '@/types/ipc'

export type SubscribableEvent = IpcEvent

export type EventListener<E extends SubscribableEvent> = (payload: IpcEventMap[E]) => void

/** The narrow slice of `PortBridge` a test needs to satisfy, structurally. */
export type SubscriptionBridge = {
  [E in SubscribableEvent as BridgeListener<E>]: (listener: EventListener<E>) => () => void
}

export interface Subscriptions {
  subscribe<E extends SubscribableEvent>(event: E, listener: EventListener<E>): () => void
}
