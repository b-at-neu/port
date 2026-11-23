import { useSyncExternalStore } from 'react'

export interface Store<T> {
  get(this: void): T
  set(next: T): void
  subscribe(this: void, listener: () => void): () => void
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial
  const listeners = new Set<() => void>()
  function notify(): void {
    for (const listener of listeners) listener()
  }
  return {
    get(this: void): T {
      return value
    },
    set(next: T): void {
      value = next
      notify()
    },
    subscribe(this: void, listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get)
}
