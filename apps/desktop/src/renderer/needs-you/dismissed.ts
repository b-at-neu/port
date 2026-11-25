// Dismissals live only in this renderer's localStorage, per event key — never on GitHub or in main.
// A missing, malformed or wrong-version stored value reads as empty, which fails toward showing every item.
import { z } from 'zod'
import type { BoardSnapshot, NeedsYouItem } from '@/types/board'
import type { HostedSessionSnapshot } from '@/types/hosting'
import { needsYouItems } from '@/renderer/board/needs-you'
import { createStore, useStore } from '@/renderer/lib/store'
import type { Store } from '@/renderer/lib/store'
import { dismissKeyOf } from '@/renderer/needs-you/dismiss-key'

const STORAGE_KEY = 'port.needsYou.dismissed'

/** Oldest dismissals drop first, so a long-lived profile never grows the value without bound. */
export const MAX_DISMISSED = 500

const entrySchema = z.object({ key: z.string(), at: z.string() })
const fileSchema = z.object({ version: z.literal(1), entries: z.array(z.unknown()) })

type DismissedEntry = z.infer<typeof entrySchema>

export interface DismissedState {
  readonly entries: readonly DismissedEntry[]
  readonly keys: ReadonlySet<string>
}

export function parseDismissed(raw: string | null): readonly DismissedEntry[] {
  if (raw === null) return []
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return []
  }
  const file = fileSchema.safeParse(json)
  if (!file.success) return []
  return file.data.entries.flatMap((entry) => {
    const parsed = entrySchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}

export function withDismissed(entries: readonly DismissedEntry[], keys: readonly string[], at: string): readonly DismissedEntry[] {
  const known = new Set(entries.map((entry) => entry.key))
  const fresh = [...new Set(keys)].filter((key) => !known.has(key)).map((key): DismissedEntry => ({ key, at }))
  if (fresh.length === 0) return entries
  return [...entries, ...fresh].slice(-MAX_DISMISSED)
}

export function withoutDismissed(entries: readonly DismissedEntry[], keys: readonly string[]): readonly DismissedEntry[] {
  const drop = new Set(keys)
  return entries.some((entry) => drop.has(entry.key)) ? entries.filter((entry) => !drop.has(entry.key)) : entries
}

function stateOf(entries: readonly DismissedEntry[]): DismissedState {
  return { entries, keys: new Set(entries.map((entry) => entry.key)) }
}

export interface DismissedStore {
  readonly store: Store<DismissedState>
  readonly dismiss: (keys: readonly string[]) => void
  readonly undismiss: (keys: readonly string[]) => void
}

/** A refused write keeps the change for this run and logs, since the next launch only loses the dismissal. */
export function createDismissedStore(storage: Pick<Storage, 'getItem' | 'setItem'>, now: () => Date): DismissedStore {
  const store = createStore(stateOf(parseDismissed(storage.getItem(STORAGE_KEY))))

  function commit(entries: readonly DismissedEntry[]): void {
    if (entries === store.get().entries) return
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, entries }))
    } catch (error) {
      console.error('Could not persist the dismissed Needs you items', error)
    }
    store.set(stateOf(entries))
  }

  return {
    store,
    dismiss: (keys) => commit(withDismissed(store.get().entries, keys, now().toISOString())),
    undismiss: (keys) => commit(withoutDismissed(store.get().entries, keys)),
  }
}

// Created on first use, so importing this module never touches `window`.
let appStore: DismissedStore | null = null

function app(): DismissedStore {
  appStore ??= createDismissedStore(window.localStorage, () => new Date())
  return appStore
}

export function dismiss(keys: readonly string[]): void {
  app().dismiss(keys)
}

export function undismiss(keys: readonly string[]): void {
  app().undismiss(keys)
}

export function dismissedKeys(): ReadonlySet<string> {
  return app().store.get().keys
}

export function useDismissed(): ReadonlySet<string> {
  return useStore(app().store).keys
}

/** Items whose event key is not dismissed — every count and list reads through this. */
export function visibleItems(items: readonly NeedsYouItem[], dismissed: ReadonlySet<string>): readonly NeedsYouItem[] {
  return items.filter((item) => !dismissed.has(dismissKeyOf(item)))
}

/** The complement of `visibleItems`: items whose event key is dismissed. */
export function dismissedItems(items: readonly NeedsYouItem[], dismissed: ReadonlySet<string>): readonly NeedsYouItem[] {
  return items.filter((item) => dismissed.has(dismissKeyOf(item)))
}

/** Dismissed items that still derive from the snapshot — a stale key with no current event has nothing to restore, so it never shows. */
export function dismissedNeedsYouItems(snapshot: BoardSnapshot, now: Date, sessions: readonly HostedSessionSnapshot[], dismissed: ReadonlySet<string>): readonly NeedsYouItem[] {
  return dismissedItems(needsYouItems(snapshot, now, sessions), dismissed)
}

/** The one composition of derived items and dismissals, shared by the hook and the notifier. */
export function visibleNeedsYouItems(snapshot: BoardSnapshot, now: Date, sessions: readonly HostedSessionSnapshot[], dismissed: ReadonlySet<string>): readonly NeedsYouItem[] {
  return visibleItems(needsYouItems(snapshot, now, sessions), dismissed)
}
