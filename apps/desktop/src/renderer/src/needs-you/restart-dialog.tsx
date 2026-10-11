// Restart's own confirmation — DESIGN §4: it has consequences (removes the kept worktree).
import { useSyncExternalStore } from 'react'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import type { InterruptedStage, StageRestartResult } from '../../../shared/stage/types'
import { invoke } from '../data/invoke'
import { ipcQueryOptions } from '../data/query'

let current: InterruptedStage | null = null
const listeners = new Set<() => void>()
function notify(): void {
  for (const listener of listeners) listener()
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
function getState(): InterruptedStage | null {
  return current
}

export function openRestartDialog(interrupted: InterruptedStage): void {
  current = interrupted
  notify()
}

function close(): void {
  current = null
  notify()
}

function resultToast(number: number, result: StageRestartResult): string {
  switch (result.kind) {
    case 'ok':
      return `Restarted #${String(number)}.`
    case 'worktree-dirty':
      return `#${String(number)}'s worktree has uncommitted changes. Resume it, or clean it up in Repositories → Worktrees.`
    case 'worktree-remove-failed':
      return `Couldn't remove #${String(number)}'s worktree: ${result.message}.`
    case 'label-refused':
      return `Couldn't put #${String(number)} back in the queue: ${result.reason}.`
    case 'unknown-stage':
      return `#${String(number)} is no longer tracked as interrupted.`
  }
}

export function RestartDialog() {
  const interrupted = useSyncExternalStore(subscribe, getState)
  const queryClient = useQueryClient()
  const open = interrupted !== null

  async function confirm(): Promise<void> {
    if (interrupted === null) return
    const number = interrupted.number
    try {
      const result = await invoke('stage:restart', { id: interrupted.id })
      toast(resultToast(number, result))
      void queryClient.invalidateQueries({ queryKey: ipcQueryOptions('board:snapshot').queryKey })
    } catch (error) {
      console.error('Failed to reach the main process while restarting a stage session', error)
      toast(`Couldn't reach the main process to restart #${String(number)}.`)
    } finally {
      close()
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && close()}>
      {interrupted !== null ? (
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restart {interrupted.agent} #{interrupted.number}?</AlertDialogTitle>
            <AlertDialogDescription>Removes its worktree and puts #{interrupted.number} back in the queue, so the next run starts the stage from scratch. Anything it hadn&apos;t pushed is lost.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirm()}>Restart stage</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      ) : null}
    </AlertDialog>
  )
}
