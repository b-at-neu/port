// The theme preference — System, Light, Dark (DESIGN §3 Settings row) — held
// outside React so `main.ts`'s own `apply()` call can run before the first
// paint, the same module-level-closure idiom `session/controller.ts` and
// `permission/controller.ts` already establish. No `useEffect`: React reads
// the live value through `useSyncExternalStore`, never a mount-time sync.
import { useSyncExternalStore } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'port.theme'

export interface ThemeStoreDeps {
  readonly storage: Pick<Storage, 'getItem' | 'setItem'>
  /** A simple shape, not `Pick<MediaQueryList, …>` — the DOM lib's own
   *  overloaded `addEventListener` makes a plain fake awkward to type, and
   *  the real `MediaQueryList` already satisfies this narrower one
   *  structurally. */
  readonly media: {
    readonly matches: boolean
    addEventListener(type: 'change', listener: () => void): void
    removeEventListener(type: 'change', listener: () => void): void
  }
  readonly root: Pick<HTMLElement, 'dataset'>
}

export interface ThemeStore {
  // `this: void` on every method `useThemePreference` passes around unbound
  // (`store.subscribe`, `store.getPreference`, `store.setPreference`) — none
  // of them reads `this`, and the annotation is what lets eslint's
  // `unbound-method` rule see that rather than assume the worst.
  getPreference(this: void): ThemePreference
  setPreference(this: void, preference: ThemePreference): void
  getResolved(): ResolvedTheme
  /** Sets `root.dataset.theme` to the resolved theme. Called once by
   *  `main.ts` before any paint, and again on every preference or OS change. */
  apply(): void
  subscribe(this: void, listener: () => void): () => void
}

function isPreference(value: string | null): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

/** A value this app did not itself write — or did not recognize — reads as
 *  `system`, so a bad value fails toward following the OS rather than
 *  freezing the app in whichever theme it last resolved to. */
function readStoredPreference(storage: ThemeStoreDeps['storage']): ThemePreference {
  const raw = storage.getItem(STORAGE_KEY)
  return isPreference(raw) ? raw : 'system'
}

function resolve(preference: ThemePreference, media: ThemeStoreDeps['media']): ResolvedTheme {
  if (preference === 'system') return media.matches ? 'dark' : 'light'
  return preference
}

export function createThemeStore({ storage, media, root }: ThemeStoreDeps): ThemeStore {
  let preference = readStoredPreference(storage)
  const listeners = new Set<() => void>()

  function notify(): void {
    for (const listener of listeners) listener()
  }

  function apply(): void {
    root.dataset.theme = resolve(preference, media)
  }

  function setPreference(next: ThemePreference): void {
    if (next === preference) return
    preference = next
    storage.setItem(STORAGE_KEY, next)
    apply()
    notify()
  }

  media.addEventListener('change', () => {
    if (preference !== 'system') return
    apply()
    notify()
  })

  return {
    getPreference: () => preference,
    setPreference,
    getResolved: () => resolve(preference, media),
    apply,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

let instance: ThemeStore | null = null

/** The one app-wide store, created lazily against real `window` globals —
 *  `store.test.ts` calls `createThemeStore` directly with fakes instead of
 *  going through this singleton. */
export function themeStore(): ThemeStore {
  instance ??= createThemeStore({
    storage: window.localStorage,
    media: window.matchMedia('(prefers-color-scheme: dark)'),
    root: document.documentElement,
  })
  return instance
}

export function useThemePreference(): readonly [ThemePreference, (preference: ThemePreference) => void] {
  const store = themeStore()
  const preference = useSyncExternalStore(store.subscribe, store.getPreference)
  return [preference, store.setPreference]
}
