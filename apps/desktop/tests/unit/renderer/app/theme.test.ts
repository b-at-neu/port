import { describe, expect, it } from 'vitest'
import { createThemeStore, parsePreference, resolveTheme } from '@/renderer/app/theme'
import type { ResolvedTheme, ThemePreference, ThemeStoreDeps } from '@/types/theme'

function fakeMedia(matches: boolean): ThemeStoreDeps['media'] & { fireChange: (matches: boolean) => void } {
  let current = matches
  const listeners = new Set<() => void>()
  return {
    get matches() {
      return current
    },
    addEventListener: (_type: string, listener: () => void) => {
      listeners.add(listener)
    },
    removeEventListener: (_type: string, listener: () => void) => {
      listeners.delete(listener)
    },
    fireChange: (next) => {
      current = next
      for (const listener of listeners) listener()
    },
  }
}

function storeWith(preference: ThemePreference, prefersDark: boolean) {
  const values = new Map([['port.theme', preference]])
  const media = fakeMedia(prefersDark)
  const root: Pick<HTMLElement, 'dataset'> = { dataset: {} }
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value as ThemePreference) }
  return { store: createThemeStore({ storage, media, root }), media, root, values }
}

describe('parsePreference', () => {
  it.each<[string | null, ThemePreference]>([
    ['dark', 'dark'],
    ['light', 'light'],
    ['system', 'system'],
    ['blue', 'system'],
    [null, 'system'],
  ])('reads %s as %s', (raw, expected) => {
    expect(parsePreference(raw)).toBe(expected)
  })
})

describe('resolveTheme', () => {
  it.each<[ThemePreference, boolean, ResolvedTheme]>([
    ['system', false, 'light'],
    ['system', true, 'dark'],
    ['light', false, 'light'],
    ['light', true, 'light'],
    ['dark', false, 'dark'],
    ['dark', true, 'dark'],
  ])('%s with prefersDark %s resolves to %s', (preference, prefersDark, expected) => {
    expect(resolveTheme(preference, prefersDark)).toBe(expected)
  })
})

describe('createThemeStore', () => {
  it('an OS change under system changes the resolved theme and the root', () => {
    const { store, media, root } = storeWith('system', false)
    store.apply()
    media.fireChange(true)
    expect(store.getResolved()).toBe('dark')
    expect(root.dataset.theme).toBe('dark')
  })

  it('an OS change under an explicit preference changes neither', () => {
    const { store, media, root } = storeWith('light', false)
    store.apply()
    media.fireChange(true)
    expect(store.getResolved()).toBe('light')
    expect(root.dataset.theme).toBe('light')
  })

  it('setPreference persists and applies', () => {
    const { store, root, values } = storeWith('system', false)
    store.setPreference('dark')
    expect(values.get('port.theme')).toBe('dark')
    expect(root.dataset.theme).toBe('dark')
  })
})
