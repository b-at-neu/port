import { useSyncExternalStore } from 'react'
import type { ResolvedTheme, ThemePreference, ThemeStoreDeps } from '@/types/theme'
import { createStore, useStore } from '@/renderer/lib/store'
import type { Store } from '@/renderer/lib/store'

const STORAGE_KEY = 'port.theme'

interface ThemeStore {
  readonly preference: Store<ThemePreference>
  readonly prefersDark: Store<boolean>
  getResolved(this: void): ResolvedTheme
  setPreference(this: void, preference: ThemePreference): void
  /** Sets `root.dataset.theme` to the resolved theme. */
  apply(this: void): void
  subscribe(this: void, listener: () => void): () => void
}

/** A value this app did not write reads as `system`, so a bad value fails toward following the OS. */
export function parsePreference(raw: string | null): ThemePreference {
  return raw === 'system' || raw === 'light' || raw === 'dark' ? raw : 'system'
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return prefersDark ? 'dark' : 'light'
  return preference
}

export function createThemeStore({ storage, media, root }: ThemeStoreDeps): ThemeStore {
  const preference = createStore(parsePreference(storage.getItem(STORAGE_KEY)))
  const prefersDark = createStore(media.matches)

  function getResolved(): ResolvedTheme {
    return resolveTheme(preference.get(), prefersDark.get())
  }

  function apply(): void {
    root.dataset.theme = getResolved()
  }

  function setPreference(next: ThemePreference): void {
    if (next === preference.get()) return
    storage.setItem(STORAGE_KEY, next)
    preference.set(next)
    apply()
  }

  media.addEventListener('change', () => {
    prefersDark.set(media.matches)
    apply()
  })

  return {
    preference,
    prefersDark,
    getResolved,
    setPreference,
    apply,
    subscribe(listener) {
      const stops = [preference.subscribe(listener), prefersDark.subscribe(listener)]
      return () => {
        for (const stop of stops) stop()
      }
    },
  }
}

let instance: ThemeStore | null = null

/** The one app-wide store, created lazily against the real window globals. */
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
  return [useStore(store.preference), store.setPreference]
}

/** The resolved value is a string, so an OS change under an explicit preference re-renders nothing. */
export function useResolvedTheme(): ResolvedTheme {
  const store = themeStore()
  return useSyncExternalStore(store.subscribe, store.getResolved)
}
