import type { QueryClient } from '@tanstack/react-query'
import type { ActionInput, ActionName, ActionOutput, QueryName } from '@/types/ipc'
import type { ActionToast } from '@/types/toast'
import type { invoke } from '@/renderer/data/invoke'
import { runInBackground, showActionToast, UNREACHABLE } from '@/renderer/lib/background-action'

export interface ActionToastSpec<N extends ActionName> {
  readonly pending?: string | ((input: ActionInput<N>) => string)
  readonly result: (output: ActionOutput<N>, input: ActionInput<N>) => ActionToast | null
}

export interface PerformSpec<N extends ActionName> {
  readonly name: N
  readonly input: ActionInput<N>
  readonly toast?: ActionToastSpec<N>
  readonly invalidates?: readonly QueryName[]
}

export interface PerformDeps {
  readonly invoke: typeof invoke
  readonly client: QueryClient
}

/** Runs one operator write. A typed `{ ok: false }` reply comes back as data; only a rejected invoke is `'unreachable'`. Every settle invalidates, because state is unknown after a failed invoke. */
export async function perform<N extends ActionName>(spec: PerformSpec<N>, deps: PerformDeps): Promise<ActionOutput<N> | 'unreachable'> {
  const { name, input, toast, invalidates = [] } = spec
  const run = () => deps.invoke(name, input)
  let result: ActionOutput<N> | 'unreachable'
  if (toast?.pending !== undefined) {
    const pending = typeof toast.pending === 'function' ? toast.pending(input) : toast.pending
    result = await runInBackground({ id: name, pending, run, toToast: (output) => toast.result(output, input) })
  } else {
    try {
      result = await run()
      const shown = toast?.result(result, input) ?? null
      if (shown !== null) showActionToast(name, shown)
    } catch (error) {
      console.error(`Failed to reach the main process for ${name}`, error)
      showActionToast(name, UNREACHABLE)
      result = 'unreachable'
    }
  }
  for (const channel of invalidates) void deps.client.invalidateQueries({ queryKey: [channel] })
  return result
}
