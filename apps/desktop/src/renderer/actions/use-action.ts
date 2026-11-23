import { useMutation } from '@tanstack/react-query'
import type { ActionInput, ActionName, ActionOutput } from '@/types/ipc'
import { invoke } from '@/renderer/data/invoke'

/** A typed imperative call to one action. A rejected invoke rejects `run`. */
export function useAction<N extends ActionName>(name: N) {
  const mutation = useMutation<ActionOutput<N>, Error, ActionInput<N>>({ mutationFn: (input) => invoke(name, input) })
  return { run: mutation.mutateAsync, pending: mutation.isPending }
}
