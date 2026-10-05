// One module-level `keydown` listener, no `useEffect`. `resolveKey` is pure;
// `installKeyboardMap` wires its result to real effects.
import type { RepoId } from '../../../shared/repos'
import type { SessionKey } from '../../../shared/hosting/types'

export interface KeyboardContext {
  readonly mod: boolean
  readonly editableFocused: boolean
  readonly dialogOpen: boolean
}

export type KeyboardAction =
  | { readonly kind: 'palette' }
  | { readonly kind: 'new-session' }
  | { readonly kind: 'jump-to-session'; readonly index: number }
  | { readonly kind: 'next-session' }
  | { readonly kind: 'toggle-sidebar' }
  | { readonly kind: 'rename-session' }
  | { readonly kind: 'list-next' }
  | { readonly kind: 'list-prev' }
  | { readonly kind: 'list-open' }

const DIGIT_RE = /^[1-9]$/

/** Pure. Bare `J`/`K`/`Enter`/`F2` resolve only outside editable focus and a dialog; mod-chorded keys always resolve. */
export function resolveKey(key: string, ctx: KeyboardContext): KeyboardAction | null {
  if (ctx.mod && key.toLowerCase() === 'k') return { kind: 'palette' }
  if (ctx.mod && key.toLowerCase() === 'n') return { kind: 'new-session' }
  if (ctx.mod && key.toLowerCase() === 'b') return { kind: 'toggle-sidebar' }
  if (ctx.mod && key === 'Tab') return { kind: 'next-session' }
  if (ctx.mod && DIGIT_RE.test(key)) return { kind: 'jump-to-session', index: Number(key) - 1 }

  if (ctx.editableFocused || ctx.dialogOpen) return null
  if (key === 'F2') return { kind: 'rename-session' }
  if (key.toLowerCase() === 'j') return { kind: 'list-next' }
  if (key.toLowerCase() === 'k') return { kind: 'list-prev' }
  if (key === 'Enter') return { kind: 'list-open' }
  return null
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
}

function isDialogOpen(): boolean {
  return document.querySelector('[role="dialog"][data-state="open"], [data-radix-popper-content-wrapper]') !== null
}

export interface KeyboardDeps {
  readonly openPalette: (page: 'root' | 'new-session') => void
  readonly readyRepoIds: () => readonly RepoId[]
  readonly startNewSession: (repoId: RepoId) => void
  readonly liveSessionKeys: () => readonly SessionKey[]
  readonly currentSessionKey: () => SessionKey | null
  readonly selectSession: (key: SessionKey) => void
  readonly toggleSidebar: () => void
  readonly startRename: () => void
  readonly currentListNavigator: () => { next(): void; prev(): void; open(): void } | undefined
  readonly noReadyRepoToast: () => void
}

let installed = false

/** Attaches the one module-level listener — calling this more than once is
 *  a no-op, so `main.ts`'s boot sequence can call it unconditionally. */
export function installKeyboardMap(deps: KeyboardDeps): void {
  if (installed) return
  installed = true

  document.addEventListener('keydown', (event) => {
    const mod = navigator.platform.toLowerCase().includes('mac') ? event.metaKey : event.ctrlKey
    const action = resolveKey(event.key, { mod, editableFocused: isEditable(event.target), dialogOpen: isDialogOpen() })
    if (action === null) return

    switch (action.kind) {
      case 'palette':
        event.preventDefault()
        deps.openPalette('root')
        return
      case 'new-session': {
        event.preventDefault()
        const ready = deps.readyRepoIds()
        if (ready.length === 1 && ready[0] !== undefined) deps.startNewSession(ready[0])
        else if (ready.length > 1) deps.openPalette('new-session')
        else deps.noReadyRepoToast()
        return
      }
      case 'jump-to-session': {
        event.preventDefault()
        const key = deps.liveSessionKeys()[action.index]
        if (key !== undefined) deps.selectSession(key)
        return
      }
      case 'next-session': {
        event.preventDefault()
        const keys = deps.liveSessionKeys()
        if (keys.length === 0) return
        const current = deps.currentSessionKey()
        const currentIndex = current === null ? -1 : keys.indexOf(current)
        const next = keys[(currentIndex + 1) % keys.length]
        if (next !== undefined) deps.selectSession(next)
        return
      }
      case 'toggle-sidebar':
        event.preventDefault()
        deps.toggleSidebar()
        return
      case 'rename-session':
        event.preventDefault()
        deps.startRename()
        return
      case 'list-next':
        deps.currentListNavigator()?.next()
        return
      case 'list-prev':
        deps.currentListNavigator()?.prev()
        return
      case 'list-open':
        deps.currentListNavigator()?.open()
    }
  })
}
