// Small `useSyncExternalStore` stores for shell-wide UI state that several
// unrelated components need to read or set (#316) — the same module-level
// closure idiom `theme/store.ts` and `session/controller.ts` already use.
// No `useEffect` anywhere: every writer calls `set`/`update` directly from an
// event handler.
import { useSyncExternalStore } from 'react'
import type { RepoId } from '../../../shared/repos'

function createStore<T>(initial: T) {
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

export type PalettePage = 'root' | 'new-session'

export interface PaletteState {
  readonly open: boolean
  readonly page: PalettePage
}

const paletteStore = createStore<PaletteState>({ open: false, page: 'root' })

export function openPalette(page: PalettePage = 'root'): void {
  paletteStore.set({ open: true, page })
}

export function closePalette(): void {
  paletteStore.set({ open: false, page: 'root' })
}

export function setPaletteOpen(open: boolean): void {
  if (!open) {
    closePalette()
    return
  }
  paletteStore.set({ ...paletteStore.get(), open: true })
}

export function usePaletteState(): PaletteState {
  return useSyncExternalStore(paletteStore.subscribe, paletteStore.get)
}

export interface PauseRequest {
  readonly repoId: RepoId
  readonly name: string
  readonly inFlight: number
}

const pauseRequestStore = createStore<PauseRequest | null>(null)

export function setPauseRequest(request: PauseRequest | null): void {
  pauseRequestStore.set(request)
}

export function usePauseRequest(): PauseRequest | null {
  return useSyncExternalStore(pauseRequestStore.subscribe, pauseRequestStore.get)
}

const renamingStore = createStore<string | null>(null)

export function setRenaming(sessionKey: string | null): void {
  renamingStore.set(sessionKey)
}

export function useRenaming(): string | null {
  return useSyncExternalStore(renamingStore.subscribe, renamingStore.get)
}

/** A registry of per-screen list navigators (#316's J/K/Enter), filled in by
 *  each screen's own ref callback. `keyboard.ts` reads the current route's
 *  entry, never holding a reference of its own. */
export interface ListNavigator {
  next(): void
  prev(): void
  open(): void
}

export type ScreenKey = 'board' | 'backlog'

const navigators = new Map<ScreenKey, ListNavigator>()

export function registerListNavigator(screen: ScreenKey, navigator: ListNavigator | null): void {
  if (navigator === null) navigators.delete(screen)
  else navigators.set(screen, navigator)
}

export function listNavigatorFor(screen: ScreenKey): ListNavigator | undefined {
  return navigators.get(screen)
}
