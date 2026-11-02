// Run/Drain/Pause for one repository, as a React mutation with toasts.
import type { RepoId } from '@/utils/repos'
import type { DispatchControlResult, RunState } from '@/types/dispatch'
import type { ActionToast, ToastButton } from '@/types/toast'
import { UNDO_LABEL } from '@/renderer/lib/copy'
import { runInBackground } from '@/renderer/lib/background-action'
import { useIpcMutation, ipcQueryOptions } from '@/renderer/data/query'
import { useQueryClient } from '@tanstack/react-query'
import type { BoardSnapshot } from '@/types/board'
import { haltHeadingCopy, haltItemLine } from '@/renderer/board/halt-copy'
import { runStateResultNote, pauseReportNote, pauseAbortedCopy, undoCommandFor } from '@/renderer/board/run-state'
import { setPauseRequest, setTakeOverRequest } from '@/renderer/shell/stores'

type DispatchCommand = DispatchControlResult['command']

const PENDING: Record<DispatchCommand, (repoName: string) => string> = {
  run: (repoName) => `Starting ${repoName}…`,
  drain: (repoName) => `Draining ${repoName}…`,
  pause: (repoName) => `Pausing ${repoName}…`,
  'take-over': (repoName) => `Taking over ${repoName}…`,
}

function applyRunState(client: ReturnType<typeof useQueryClient>, repoId: RepoId, result: Extract<DispatchControlResult, { readonly command: 'run' | 'drain' | 'pause' | 'take-over' }>): void {
  if (!result.ok) return
  client.setQueryData(ipcQueryOptions('board:snapshot').queryKey, (snapshot: BoardSnapshot | undefined) => {
    if (snapshot === undefined) return snapshot
    const repositories = snapshot.runStates.repositories.map((entry) => (entry.repoId === repoId ? result.runState : entry))
    return { ...snapshot, runStates: { ...snapshot.runStates, repositories } }
  })
}

export function useRunStateCommand() {
  const mutation = useIpcMutation('dispatch:control')
  const client = useQueryClient()

  function priorState(repoId: RepoId): RunState | null {
    const snapshot = client.getQueryData(ipcQueryOptions('board:snapshot').queryKey)
    return snapshot?.runStates.repositories.find((entry) => entry.repoId === repoId)?.state ?? null
  }

  function inFlightOf(repoId: RepoId): number {
    const snapshot = client.getQueryData(ipcQueryOptions('board:snapshot').queryKey)
    return snapshot?.tick.find((entry) => entry.repoId === repoId)?.claims.length ?? 0
  }

  function undoActionFor(prior: RunState | null, command: 'run' | 'drain', repoId: RepoId, repoName: string): ToastButton | null {
    const undo = undoCommandFor(prior, command)
    if (undo === null) return null
    const onClick = undo === 'pause' ? () => requestPause(repoId, repoName, inFlightOf(repoId)) : () => void send(undo, repoId, repoName, false)
    return { label: UNDO_LABEL, onClick }
  }

  function requestPause(repoId: RepoId, repoName: string, inFlight: number): void {
    if (inFlight === 0) {
      void send('pause', repoId, repoName, false)
      return
    }
    setPauseRequest({ repoId, name: repoName, inFlight })
  }

  function toastFor(result: DispatchControlResult, prior: RunState | null, repoName: string, undoable: boolean): ActionToast {
    const plain = { description: null, action: null, cancel: null } as const
    if (!result.ok) return { ...plain, tone: 'error', title: runStateResultNote(result) ?? `Couldn't ${result.command === 'take-over' ? 'take over' : result.command} ${repoName}.` }
    if (result.command === 'run') return { ...plain, tone: 'success', title: `${repoName} is running`, action: undoable ? undoActionFor(prior, 'run', result.repoId, repoName) : null }
    if (result.command === 'take-over') return { ...plain, tone: 'success', title: `${repoName} is running here` }
    if (result.command === 'drain') {
      const note = runStateResultNote(result)
      if (note !== null) return { ...plain, tone: 'error', title: note }
      return { ...plain, tone: 'info', title: 'Work in progress finishes; nothing new starts.', description: `${repoName} is draining`, action: undoable ? undoActionFor(prior, 'drain', result.repoId, repoName) : null }
    }
    if (result.report.kind === 'aborted') return { ...plain, tone: 'error', title: pauseAbortedCopy(result.report) }
    const lines = result.report.items.map((item) => haltItemLine(item, new Date()))
    return { ...plain, tone: 'success', title: haltHeadingCopy(result.report, 'Paused'), description: [pauseReportNote(result.report, repoName), ...lines].join(' — ') }
  }

  async function send(command: DispatchCommand, repoId: RepoId, repoName: string, undoable = true): Promise<void> {
    const prior = priorState(repoId)
    await runInBackground({
      id: `run-state:${repoId}`,
      pending: PENDING[command](repoName),
      run: async () => {
        const result = await mutation.mutateAsync({ command, repoId })
        applyRunState(client, repoId, result)
        return result
      },
      toToast: (result) => toastFor(result, prior, repoName, undoable),
    })
  }

  return {
    run(repoId: RepoId, repoName: string): void {
      void send('run', repoId, repoName)
    },
    drain(repoId: RepoId, repoName: string): void {
      void send('drain', repoId, repoName)
    },
    /** Applies at once with zero in flight; otherwise arms the pause-confirm
     *  dialog (DESIGN §4: a consequential action opens an `AlertDialog`). */
    requestPause,
    confirmPause(repoId: RepoId, repoName: string): void {
      setPauseRequest(null)
      void send('pause', repoId, repoName)
    },
    /** Arms `take-over-confirm.tsx`'s `AlertDialog` — a consequential action, never applied at once. */
    requestTakeOver(repoId: RepoId, repoName: string): void {
      setTakeOverRequest({ repoId, name: repoName })
    },
    async confirmTakeOver(repoId: RepoId, repoName: string): Promise<void> {
      setTakeOverRequest(null)
      await send('take-over', repoId, repoName)
    },
    pending: mutation.isPending,
  }
}
