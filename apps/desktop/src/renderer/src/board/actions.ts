// The board's single-label operator actions controller (#94, #319) — the
// `item:action` IPC channel's only renderer caller, and the per-item
// pending/result state `ticket-row.tsx`/`item-pane.tsx` render from through
// `subscribeItemActions` (`useSyncExternalStore`, no `useEffect`). `rows.ts`'s
// own click-delegation and the Decision-1 fingerprint are both gone with it —
// a React re-render needs neither a DOM click target to parse nor a second
// string to detect "something changed" the store's own `notify()` already
// signals directly.
import type { RepoId } from '../../../shared/repos'
import type { LabelKey } from '../../../shared/labels/vocabulary'
import type { ItemActionResult, OperatorAction } from '../../../shared/actions/types'
import type { BoardSnapshot } from '../../../shared/board/types'

export type ItemActionState = { readonly kind: 'pending'; readonly action: OperatorAction } | { readonly kind: 'result'; readonly action: OperatorAction; readonly result: ItemActionResult }

const states = new Map<string, ItemActionState>()
const listeners = new Set<() => void>()

function keyOf(repoId: RepoId, number: number): string {
  return `${repoId}#${String(number)}`
}

function notify(): void {
  for (const listener of listeners) listener()
}

/** `useSyncExternalStore`'s own subscribe half — every item's own state lives
 *  in one store, so every subscriber re-renders on any item's change; cheap,
 *  since a render that finds its own `itemActionState` unchanged is a no-op
 *  React diff, not a repaint. */
export function subscribeItemActions(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The read half — `undefined` when nothing has been clicked for this item
 *  yet. */
export function itemActionState(repoId: RepoId, number: number): ItemActionState | undefined {
  return states.get(keyOf(repoId, number))
}

/** Evicts any per-item state whose item is absent from a fresh snapshot —
 *  merged, closed, reassigned away, or otherwise dropped off the board —
 *  since without this the map only ever grows for the renderer's whole life
 *  (#94 review). Call this once per fresh snapshot, never per render: a
 *  snapshot is the only signal that can tell "no longer on the board" apart
 *  from "just not in this frame". */
export function pruneItemActionStates(snapshot: BoardSnapshot): void {
  const live = new Set<string>()
  for (const repo of snapshot.state.repositories) {
    if (!repo.ok) continue
    for (const item of repo.items) live.add(keyOf(repo.repoId, item.number))
  }
  let changed = false
  for (const key of states.keys()) {
    if (!live.has(key)) {
      states.delete(key)
      changed = true
    }
  }
  if (changed) notify()
}

export interface RunItemActionParams {
  readonly repoId: RepoId
  readonly kind: 'issue' | 'pull-request'
  readonly number: number
  readonly action: OperatorAction
  readonly expectedStage: LabelKey | null
}

/** One action in flight per item — a second call while one is pending is
 *  ignored; the row's other buttons are disabled meanwhile
 *  (`row.actions`/`itemActionState`), so this is a defensive second guard,
 *  not the only one. */
export async function runItemAction(params: RunItemActionParams): Promise<void> {
  const { repoId, kind, number, action, expectedStage } = params
  const key = keyOf(repoId, number)
  if (states.get(key)?.kind === 'pending') return

  states.set(key, { kind: 'pending', action })
  notify()
  try {
    const result = await window.port.itemAction({ repoId, kind, number, action, expectedStage })
    states.set(key, { kind: 'result', action, result })
  } catch (error) {
    console.error('Failed to reach the main process while applying an item action', error)
    // No `ItemActionResult` reason means "couldn't reach the main process at
    // all" — `repo-unavailable` is the closest existing meaning (nothing
    // could be read), reused rather than inventing a seventh reason outside
    // the plan's own contract.
    states.set(key, { kind: 'result', action, result: { ok: false, reason: 'repo-unavailable' } })
  }
  notify()
}
