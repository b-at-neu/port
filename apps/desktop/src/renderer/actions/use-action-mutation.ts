import { createElement, useState } from 'react'
import type { ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ActionInput, ActionOutput, MutationName, QueryName } from '@/types/ipc'
import { invoke } from '@/renderer/data/invoke'
import { perform } from '@/renderer/actions/perform'
import type { ActionToastSpec } from '@/renderer/actions/perform'
import { ConfirmDialog } from '@/renderer/components/confirm-dialog'
import type { ConfirmSpec } from '@/renderer/components/confirm-dialog'

interface ActionMutationOptions<N extends MutationName> {
  readonly confirm?: (input: ActionInput<N>) => ConfirmSpec
  readonly toast?: ActionToastSpec<N>
  readonly invalidates?: readonly QueryName[]
}

interface Requested<N extends MutationName> {
  readonly input: ActionInput<N>
  readonly spec: ConfirmSpec
  readonly open: boolean
}

/** Every write button's one path. The caller renders `confirmDialog` once; request and perform are event-handler calls only. */
export function useActionMutation<N extends MutationName>(name: N, options: ActionMutationOptions<N> = {}) {
  const client = useQueryClient()
  const [requested, setRequested] = useState<Requested<N> | null>(null)
  const mutation = useMutation<ActionOutput<N> | 'unreachable', Error, ActionInput<N>>({
    mutationFn: (input) => perform({ name, input, toast: options.toast, invalidates: options.invalidates }, { invoke, client }),
  })

  function run(input: ActionInput<N>): Promise<ActionOutput<N> | 'unreachable'> {
    return mutation.mutateAsync(input)
  }

  function request(input: ActionInput<N>): void {
    if (options.confirm === undefined) void run(input)
    else setRequested({ input, spec: options.confirm(input), open: true })
  }

  function close(): void {
    setRequested((current) => (current === null ? null : { ...current, open: false }))
  }

  const confirmDialog: ReactNode =
    requested === null
      ? null
      : createElement(ConfirmDialog, {
          ...requested.spec,
          open: requested.open,
          onCancel: close,
          onConfirm: () => {
            close()
            void run(requested.input)
          },
        })

  return { request, perform: run, pending: mutation.isPending, confirmDialog }
}
