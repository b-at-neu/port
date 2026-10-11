import { describe, expect, it } from 'vitest'
import { createThemeStore } from './store'
import type { ThemeStoreDeps } from './store'

function fakeStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

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

function fakeRoot(): Pick<HTMLElement, 'dataset'> {
  return { dataset: {} }
}

describe('createThemeStore', () => {
  it('reads an invalid stored value as system', () => {
    const store = createThemeStore({ storage: fakeStorage({ 'port.theme': 'blue' }), media: fakeMedia(false), root: fakeRoot() })
    expect(store.getPreference()).toBe('system')
  })

  it('reads a missing stored value as system', () => {
    const store = createThemeStore({ storage: fakeStorage(), media: fakeMedia(true), root: fakeRoot() })
    expect(store.getPreference()).toBe('system')
    expect(store.getResolved()).toBe('dark')
  })

  it('reads a valid stored value back', () => {
    const store = createThemeStore({ storage: fakeStorage({ 'port.theme': 'dark' }), media: fakeMedia(false), root: fakeRoot() })
    expect(store.getPreference()).toBe('dark')
    expect(store.getResolved()).toBe('dark')
  })

  it('system follows a media change and notifies subscribers', () => {
    const media = fakeMedia(false)
    const store = createThemeStore({ storage: fakeStorage(), media, root: fakeRoot() })
    let notified = 0
    store.subscribe(() => {
      notified++
    })
    expect(store.getResolved()).toBe('light')
    media.fireChange(true)
    expect(store.getResolved()).toBe('dark')
    expect(notified).toBe(1)
  })

  it('a media change is ignored once an explicit preference is set', () => {
    const media = fakeMedia(false)
    const store = createThemeStore({ storage: fakeStorage(), media, root: fakeRoot() })
    store.setPreference('light')
    let notified = 0
    store.subscribe(() => {
      notified++
    })
    media.fireChange(true)
    expect(store.getResolved()).toBe('light')
    expect(notified).toBe(0)
  })

  it('apply sets data-theme on the root', () => {
    const root = fakeRoot()
    const store = createThemeStore({ storage: fakeStorage({ 'port.theme': 'dark' }), media: fakeMedia(false), root })
    store.apply()
    expect(root.dataset.theme).toBe('dark')
  })

  it('setPreference persists, applies and notifies', () => {
    const storage = fakeStorage()
    const root = fakeRoot()
    const store = createThemeStore({ storage, media: fakeMedia(false), root })
    let notified = 0
    store.subscribe(() => {
      notified++
    })
    store.setPreference('dark')
    expect(root.dataset.theme).toBe('dark')
    expect(storage.getItem('port.theme')).toBe('dark')
    expect(notified).toBe(1)
  })
})
