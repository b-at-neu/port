// Small `useSyncExternalStore` stores for shell-wide UI state. No `useEffect`
// anywhere: every writer calls `set` directly from an event handler.
import { useSyncExternalStore } from 'react'
import type { RepoId } from '../../../shared/repos'
import type { NewSessionPreselect } from '../session/new-session-model'

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

export type PalettePage = 'root'

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

export interface NewSessionDialogState {
  readonly open: boolean
  readonly preselect: NewSessionPreselect
}

const newSessionDialogStore = createStore<NewSessionDialogState>({ open: false, preselect: null })

export function openNewSessionDialog(preselect: NewSessionPreselect = null): void {
  newSessionDialogStore.set({ open: true, preselect })
}

export function closeNewSessionDialog(): void {
  newSessionDialogStore.set({ open: false, preselect: null })
}

export function useNewSessionDialog(): NewSessionDialogState {
  return useSyncExternalStore(newSessionDialogStore.subscribe, newSessionDialogStore.get)
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

/** The sidebar's own Take over confirmation, armed the same way `PauseRequest` arms its own. */
export interface TakeOverRequest {
  readonly repoId: RepoId
  readonly name: string
}

const takeOverRequestStore = createStore<TakeOverRequest | null>(null)

export function setTakeOverRequest(request: TakeOverRequest | null): void {
  takeOverRequestStore.set(request)
}

export function useTakeOverRequest(): TakeOverRequest | null {
  return useSyncExternalStore(takeOverRequestStore.subscribe, takeOverRequestStore.get)
}

const renamingStore = createStore<string | null>(null)

export function setRenaming(sessionKey: string | null): void {
  renamingStore.set(sessionKey)
}

export function useRenaming(): string | null {
  return useSyncExternalStore(renamingStore.subscribe, renamingStore.get)
}

/** A shared store, not a local `useState` — the palette and the keyboard
 *  map both flip it from outside the `Sidebar` component. */
const sidebarCollapsedStore = createStore(false)

export function initSidebarCollapsed(collapsed: boolean): void {
  sidebarCollapsedStore.set(collapsed)
}

export function toggleSidebarCollapsed(): boolean {
  const next = !sidebarCollapsedStore.get()
  sidebarCollapsedStore.set(next)
  return next
}

export function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(sidebarCollapsedStore.subscribe, sidebarCollapsedStore.get)
}

export interface ListNavigator {
  next(): void
  prev(): void
  open(): void
}

export type ScreenKey = 'board' | 'backlog' | 'needsYou'

const navigators = new Map<ScreenKey, ListNavigator>()

export function registerListNavigator(screen: ScreenKey, navigator: ListNavigator | null): void {
  if (navigator === null) navigators.delete(screen)
  else navigators.set(screen, navigator)
}

export function listNavigatorFor(screen: ScreenKey): ListNavigator | undefined {
  return navigators.get(screen)
}
