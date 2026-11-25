// Shared view-model and bridge-subscription types for renderer/data/ — multi-file or test-only.
import type { EventMap, EventName } from '@/types/ipc'

export type SubscribableEvent = EventName

export type EventListener<E extends SubscribableEvent> = (payload: EventMap[E]) => void

/** The narrow slice of `PortBridge` a test needs to satisfy, structurally. */
export interface SubscriptionBridge {
  readonly on: <E extends SubscribableEvent>(event: E, listener: EventListener<E>) => () => void
}

export interface Subscriptions {
  subscribe<E extends SubscribableEvent>(event: E, listener: EventListener<E>): () => void
}
