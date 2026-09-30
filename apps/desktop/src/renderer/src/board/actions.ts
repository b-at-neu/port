// The board's single-label operator actions controller (#94) — the
// `item:action` IPC channel's only renderer caller, and the per-item pending/
// result state `rows.ts`/`view.ts` render from. `main.ts` delegates its one
// `item-*` click branch here rather than owning this state itself, the same
// split `claim/controller.ts` draws for the claim dialog's own actions.
import type { RepoId } from '../../../shared/repos'
import type { LabelKey } from '../../../shared/labels/vocabulary'
import type { ItemActionResult, OperatorAction } from '../../../shared/actions/types'
import type { BoardSnapshot } from '../../../shared/board/types'

export type ItemActionState = { readonly kind: 'pending'; readonly action: OperatorAction } | { readonly kind: 'result'; readonly action: OperatorAction; readonly result: ItemActionResult }

const states = new Map<string, ItemActionState>()

function keyOf(repoId: RepoId, number: number): string {
  return `${repoId}#${String(number)}`
}

/** `rows.ts`'s own lookup — `undefined` when nothing has been clicked for
 *  this item yet. */
export function itemActionState(repoId: RepoId, number: number): ItemActionState | undefined {
  return states.get(keyOf(repoId, number))
}

/** Folded into the board's own no-op guard (`view.ts`) alongside
 *  `projection.signature` — an action result never changes the projection
 *  itself (GitHub has not been re-read yet when the response lands), so
 *  without this a result would never repaint. */
export function actionsFingerprint(): string {
  return JSON.stringify([...states.entries()])
}

/** Evicts any per-item state whose item is absent from a fresh snapshot —
 *  merged, closed, reassigned away, or otherwise dropped off the board —
 *  since without this the map only ever grows for the renderer's whole life
 *  (#94 review). Call this once per fresh snapshot (`main.ts`'s
 *  `applySnapshot`), never per render: a snapshot is the only signal that
 *  can tell "no longer on the board" apart from "just not in this frame". */
export function pruneItemActionStates(snapshot: BoardSnapshot): void {
  const live = new Set<string>()
  for (const repo of snapshot.state.repositories) {
    if (!repo.ok) continue
    for (const item of repo.items) live.add(keyOf(repo.repoId, item.number))
  }
  for (const key of states.keys()) {
    if (!live.has(key)) states.delete(key)
  }
}

export interface HandleItemActionParams {
  readonly repoId: RepoId
  readonly kind: 'issue' | 'pull-request'
  readonly number: number
  readonly action: OperatorAction
  readonly expectedStage: LabelKey | null
  readonly redraw: () => void
}

/** One action in flight per item — a second click while one is pending is
 *  ignored; the row's other buttons are disabled meanwhile (`rows.ts`), so
 *  this is a defensive second guard, not the only one. */
export async function handleItemAction(params: HandleItemActionParams): Promise<void> {
  const { repoId, kind, number, action, expectedStage, redraw } = params
  const key = keyOf(repoId, number)
  if (states.get(key)?.kind === 'pending') return

  states.set(key, { kind: 'pending', action })
  redraw()
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
  redraw()
}
