// Small `useSyncExternalStore` stores for shell-wide UI state. No `useEffect`
// anywhere: every writer calls `set` directly from an event handler.
import type { NewSessionPreselect } from '@/types/session'
import { createStore, useStore } from '@/renderer/lib/store'

type PalettePage = 'root'

interface PaletteState {
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
  return useStore(paletteStore)
}

interface NewSessionDialogState {
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
  return useStore(newSessionDialogStore)
}

const renamingStore = createStore<string | null>(null)

export function setRenaming(sessionKey: string | null): void {
  renamingStore.set(sessionKey)
}

export function useRenaming(): string | null {
  return useStore(renamingStore)
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
  return useStore(sidebarCollapsedStore)
}
