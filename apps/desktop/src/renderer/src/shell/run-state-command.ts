// Run/Drain/Pause for one repository, as a React mutation with toasts.
import { toast } from 'sonner'
import type { RepoId } from '../../../shared/repos'
import type { DispatchControlResult } from '../../../shared/dispatch/types'
import { useIpcMutation, ipcQueryOptions } from '../data/query'
import { useQueryClient } from '@tanstack/react-query'
import type { BoardSnapshot } from '../../../shared/board/types'
import { haltHeadingCopy, haltItemLine } from '../board/halt-copy'
import { runStateResultNote, pauseReportNote, pauseAbortedCopy } from '../board/run-state'
import { setPauseRequest, setTakeOverRequest } from './stores'

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

  async function send(command: 'run' | 'drain' | 'pause', repoId: RepoId, repoName: string): Promise<void> {
    try {
      const result = await mutation.mutateAsync({ command, repoId })
      if (result.command === 'run') {
        if (!result.ok) {
          toast.error(runStateResultNote(result) ?? `Couldn't run ${repoName}.`)
          return
        }
        applyRunState(client, repoId, result)
        toast.success(`${repoName} is running`)
      } else if (result.command === 'drain') {
        if (!result.ok) {
          toast.error(runStateResultNote(result) ?? `Couldn't drain ${repoName}.`)
          return
        }
        applyRunState(client, repoId, result)
        const note = runStateResultNote(result)
        if (note !== null) toast.error(note)
        else toast('Work in progress finishes; nothing new starts.', { description: `${repoName} is draining` })
      } else if (result.command === 'pause') {
        applyRunState(client, repoId, result)
        if (result.report.kind === 'aborted') {
          toast.error(pauseAbortedCopy(result.report))
        } else {
          const heading = haltHeadingCopy(result.report, 'Paused')
          const lines = result.report.items.map((item) => haltItemLine(item, new Date()))
          toast(heading, { description: [pauseReportNote(result.report, repoName), ...lines].join(' — ') })
        }
      }
    } catch (error) {
      console.error(`Failed to reach the main process for dispatch ${command}`, error)
      toast.error("Couldn't reach the main process. Restart port to try again.")
    }
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
    requestPause(repoId: RepoId, repoName: string, inFlight: number): void {
      if (inFlight === 0) {
        void send('pause', repoId, repoName)
        return
      }
      setPauseRequest({ repoId, name: repoName, inFlight })
    },
    confirmPause(repoId: RepoId, repoName: string): void {
      setPauseRequest(null)
      void send('pause', repoId, repoName)
    },
    /** #331: arms `take-over-confirm.tsx`'s `AlertDialog` (DESIGN §4: a
     *  consequential action) — the sidebar's own Take over, never applied
     *  at once the way an empty-in-flight pause is. */
    requestTakeOver(repoId: RepoId, repoName: string): void {
      setTakeOverRequest({ repoId, name: repoName })
    },
    async confirmTakeOver(repoId: RepoId, repoName: string): Promise<void> {
      setTakeOverRequest(null)
      try {
        const result = await mutation.mutateAsync({ command: 'take-over', repoId })
        if (result.command !== 'take-over') return
        if (!result.ok) {
          toast.error(runStateResultNote(result) ?? `Couldn't take over ${repoName}.`)
          return
        }
        applyRunState(client, repoId, result)
        toast.success(`${repoName} is running here`)
      } catch (error) {
        console.error('Failed to reach the main process for dispatch take-over', error)
        toast.error("Couldn't reach the main process. Restart port to try again.")
      }
    },
    pending: mutation.isPending,
  }
}
