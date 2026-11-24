// Run, Drain and Stop for one repository — the sidebar menu and the palette share this hook.
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { RepoId } from '@/utils/repos'
import type { DispatchCommand, DispatchControlResult, RunState } from '@/types/dispatch'
import type { ToastButton } from '@/types/toast'
import { UNDO_LABEL } from '@/renderer/lib/copy'
import { ipcQueryOptions } from '@/renderer/data/query'
import { useActionMutation } from '@/renderer/actions/use-action-mutation'
import { undoCommandFor } from '@/renderer/board/run-state'
import { PENDING, pauseConfirm, runStateToast } from '@/renderer/app/run-state-toast'

interface CallContext {
  readonly name: string
  readonly prior: RunState | null
  readonly undoable: boolean
}

export function useRunState() {
  const client = useQueryClient()
  const [contexts] = useState(() => new Map<RepoId, CallContext>())

  function inFlightOf(repoId: RepoId): number {
    const snapshot = client.getQueryData(ipcQueryOptions('board.snapshot').queryKey)
    return snapshot?.tick.find((entry) => entry.repoId === repoId)?.claims.length ?? 0
  }

  function remember(repoId: RepoId, name: string, undoable: boolean): void {
    const snapshot = client.getQueryData(ipcQueryOptions('board.snapshot').queryKey)
    const prior = snapshot?.runStates.repositories.find((entry) => entry.repoId === repoId)?.state ?? null
    contexts.set(repoId, { name, prior, undoable })
  }

  function undoButton(result: DispatchControlResult, context: CallContext): ToastButton | null {
    if (!context.undoable || result.command === 'pause') return null
    const undo = undoCommandFor(context.prior, result.command)
    if (undo === null) return null
    const onClick = undo === 'pause' ? () => stop(result.repoId, context.name) : () => void send(undo, result.repoId, context.name, false)
    return { label: UNDO_LABEL, onClick }
  }

  function toast(command: DispatchCommand) {
    return {
      pending: PENDING[command],
      result: (output: DispatchControlResult) => {
        const context = contexts.get(output.repoId)
        if (context === undefined) return null
        return runStateToast(output, { name: context.name, undo: undoButton(output, context), now: new Date() })
      },
    }
  }

  const invalidates = ['board.snapshot'] as const
  const run = useActionMutation('dispatch.control', { toast: toast('run'), invalidates })
  const drain = useActionMutation('dispatch.control', { toast: toast('drain'), invalidates })
  const pause = useActionMutation('dispatch.control', {
    toast: toast('pause'),
    invalidates,
    confirm: (input) => pauseConfirm(contexts.get(input.repoId)?.name ?? '', inFlightOf(input.repoId)),
  })
  const mutations = { run, drain, pause }

  async function send(command: DispatchCommand, repoId: RepoId, name: string, undoable: boolean): Promise<void> {
    remember(repoId, name, undoable)
    await mutations[command].perform({ command, repoId })
  }

  function stop(repoId: RepoId, name: string): void {
    remember(repoId, name, false)
    if (inFlightOf(repoId) === 0) void pause.perform({ command: 'pause', repoId })
    else pause.request({ command: 'pause', repoId })
  }

  return {
    run: (repoId: RepoId, name: string): void => void send('run', repoId, name, true),
    drain: (repoId: RepoId, name: string): void => void send('drain', repoId, name, true),
    stop,
    pending: run.pending || drain.pending || pause.pending,
    confirmDialog: pause.confirmDialog,
  }
}
