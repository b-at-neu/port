// Dismissals live only in this renderer's localStorage, per event key — never on GitHub or in main.
// A malformed stored value reads as empty, which fails toward showing every item.
import { useSyncExternalStore } from 'react'
import type { NeedsYouItem } from '@/types/board'
import { dismissKeyOf } from '@/renderer/needs-you/dismiss-key'

const STORAGE_KEY = 'port.needsYou.dismissed'

/** Oldest dismissals drop first, so a long-lived profile never grows the value without bound. */
export const MAX_DISMISSED = 500

interface DismissedEntry {
  readonly key: string
  readonly at: string
}

interface DismissedFile {
  readonly version: 1
  readonly entries: readonly DismissedEntry[]
}

function isEntry(value: unknown): value is DismissedEntry {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).key === 'string' && typeof (value as Record<string, unknown>).at === 'string'
}

export function parseDismissed(raw: string | null): DismissedFile {
  const empty: DismissedFile = { version: 1, entries: [] }
  if (raw === null) return empty
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return empty
    const value = parsed as Record<string, unknown>
    if (value.version !== 1 || !Array.isArray(value.entries)) return empty
    return { version: 1, entries: value.entries.filter(isEntry) }
  } catch {
    return empty
  }
}

export interface DismissedStore {
  readonly get: () => ReadonlySet<string>
  readonly dismiss: (keys: readonly string[]) => void
  readonly undismiss: (keys: readonly string[]) => void
  readonly subscribe: (listener: () => void) => () => void
}

/** `createDismissedStore(storage, now)` — `get()` returns the same set until a write changes it, as `useSyncExternalStore` requires. */
export function createDismissedStore(storage: Pick<Storage, 'getItem' | 'setItem'>, now: () => Date): DismissedStore {
  const listeners = new Set<() => void>()
  let entries: readonly DismissedEntry[] = parseDismissed(storage.getItem(STORAGE_KEY)).entries
  let keys: ReadonlySet<string> = new Set(entries.map((entry) => entry.key))

  function commit(next: readonly DismissedEntry[]): void {
    entries = next
    keys = new Set(next.map((entry) => entry.key))
    try {
      const file: DismissedFile = { version: 1, entries }
      storage.setItem(STORAGE_KEY, JSON.stringify(file))
    } catch (error) {
      console.error('Could not persist the dismissed Needs you items', error)
    }
    for (const listener of listeners) listener()
  }

  return {
    get: () => keys,
    dismiss(add) {
      const at = now().toISOString()
      const fresh = [...new Set(add)].filter((key) => !keys.has(key)).map((key): DismissedEntry => ({ key, at }))
      if (fresh.length === 0) return
      commit([...entries, ...fresh].slice(-MAX_DISMISSED))
    },
    undismiss(remove) {
      const drop = new Set(remove)
      if (!entries.some((entry) => drop.has(entry.key))) return
      commit(entries.filter((entry) => !drop.has(entry.key)))
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

// Created on first use, so importing this module never touches `window`.
let appStore: DismissedStore | null = null

function store(): DismissedStore {
  appStore ??= createDismissedStore(window.localStorage, () => new Date())
  return appStore
}

export function dismiss(keys: readonly string[]): void {
  store().dismiss(keys)
}

export function undismiss(keys: readonly string[]): void {
  store().undismiss(keys)
}

export function dismissedKeys(): ReadonlySet<string> {
  return store().get()
}

export function useDismissed(): ReadonlySet<string> {
  return useSyncExternalStore(store().subscribe, store().get)
}

/** Items whose event key is not dismissed — every count and list reads through this. */
export function visibleItems(items: readonly NeedsYouItem[], dismissed: ReadonlySet<string>): readonly NeedsYouItem[] {
  return items.filter((item) => !dismissed.has(dismissKeyOf(item)))
}
