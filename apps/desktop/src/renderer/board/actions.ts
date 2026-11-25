// The board's per-item operator action state, and the one hook every row action goes through.
import type { RepoId } from '@/utils/repos'
import type { BoardItemRow, BoardSnapshot, ItemActionState } from '@/types/board'
import type { OperatorAction } from '@/types/actions'
import type { ActionToast } from '@/types/toast'
import { useActionMutation } from '@/renderer/actions/use-action-mutation'
import { actionResultCopy } from '@/renderer/board/copy'
import { createStore, useStore } from '@/renderer/lib/store'

type ItemActionStates = ReadonlyMap<string, ItemActionState>

const itemActions = createStore<ItemActionStates>(new Map())

function itemActionKey(repoId: RepoId, number: number): string {
  return `${repoId}#${String(number)}`
}

/** The same map when every item is still on the board, else a copy without the items absent from every ready repository. */
export function withoutGone(states: ItemActionStates, snapshot: BoardSnapshot): ItemActionStates {
  const live = new Set<string>()
  for (const repo of snapshot.state.repositories) {
    if (!repo.ok) continue
    for (const item of repo.items) live.add(itemActionKey(repo.repoId, item.number))
  }
  const kept = [...states].filter(([key]) => live.has(key))
  return kept.length === states.size ? states : new Map(kept)
}

/** Call once per fresh snapshot: a snapshot is the only signal that tells "no longer on the board" from "not in this frame". */
export function pruneItemActionStates(snapshot: BoardSnapshot): void {
  const current = itemActions.get()
  const next = withoutGone(current, snapshot)
  if (next !== current) itemActions.set(next)
}

export function useItemActionState(repoId: RepoId, number: number): ItemActionState | undefined {
  return useStore(itemActions).get(itemActionKey(repoId, number))
}

export function useItemAction(row: BoardItemRow) {
  const { repoId, kind, number } = row.item
  const key = itemActionKey(repoId, number)
  const state = useItemActionState(repoId, number)

  const mutation = useActionMutation('item.action', {
    toast: {
      result: (output, input): ActionToast | null => {
        if (output.ok && output.outcome.kind === 'applied') return null
        const availability = row.actions[input.action]
        return {
          tone: 'error',
          title: actionResultCopy({
            action: input.action,
            number: row.ticket.ref.number,
            plan: availability.available ? availability.plan : null,
            currentStageName: row.stageLabel?.name ?? null,
            result: output,
            now: new Date(),
          }),
          description: null,
          action: null,
          cancel: null,
        }
      },
    },
  })

  async function run(action: OperatorAction): Promise<void> {
    if (itemActions.get().get(key)?.kind === 'pending') return
    setItemActionState(key, { kind: 'pending', action })
    const result = await mutation.perform({ repoId, kind, number, action, expectedStage: row.stageLabel?.key ?? null })
    setItemActionState(key, result === 'unreachable' ? undefined : { kind: 'result', action, result })
  }

  return { state, run }
}

function setItemActionState(key: string, state: ItemActionState | undefined): void {
  const next = new Map(itemActions.get())
  if (state === undefined) next.delete(key)
  else next.set(key, state)
  itemActions.set(next)
}
