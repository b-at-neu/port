// "Dispatch anyway"'s own confirmation — DESIGN §4: it has consequences (both agents can edit the
// same files at once).
import { useSyncExternalStore } from 'react'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/renderer/components/ui/alert-dialog'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import type { TickHeld } from '@/types/tick'
import type { RepoId } from '@/utils/repos'
import type { HeldForceDispatchResult } from '@/types/ipc'
import { invoke } from '@/renderer/data/invoke'
import { ipcQueryOptions } from '@/renderer/data/query'

interface ForceDispatchTarget {
  readonly repoId: RepoId
  readonly number: number
  readonly held: TickHeld
}

let current: ForceDispatchTarget | null = null
const listeners = new Set<() => void>()
function notify(): void {
  for (const listener of listeners) listener()
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
function getState(): ForceDispatchTarget | null {
  return current
}

export function openForceDispatchDialog(target: ForceDispatchTarget): void {
  current = target
  notify()
}

function close(): void {
  current = null
  notify()
}

function resultToast(number: number, result: HeldForceDispatchResult): string {
  switch (result.kind) {
    case 'ok':
      return `#${String(number)} will dispatch on the next tick.`
    case 'not-held':
      return `#${String(number)} isn't held anymore. Nothing to force.`
    case 'not-owned':
      return `This app doesn't run that repository, so it can't dispatch #${String(number)}.`
  }
}

export function ForceDispatchDialog() {
  const target = useSyncExternalStore(subscribe, getState)
  const queryClient = useQueryClient()
  const open = target !== null
  const contention = target?.held.contention ?? null

  async function confirm(): Promise<void> {
    if (target === null) return
    const { repoId, number } = target
    try {
      const result = await invoke('held:force-dispatch', { repoId, number })
      toast(resultToast(number, result))
      void queryClient.invalidateQueries({ queryKey: ipcQueryOptions('board:snapshot').queryKey })
    } catch (error) {
      console.error('Failed to reach the main process while forcing a dispatch', error)
      toast(`Couldn't reach the main process to dispatch #${String(number)}.`)
    } finally {
      close()
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && close()}>
      {target !== null && contention !== null ? (
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Dispatch #{target.number} anyway?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p>
                  #{target.number} shares {contention.paths.length} file(s) with #{contention.blocker} ({contention.blockerStage}):
                </p>
                <ul className="list-inside list-disc">
                  {contention.paths.map((path) => (
                    <li key={path} className="font-mono">
                      {path}
                    </li>
                  ))}
                </ul>
                <p>Both will edit these files at once, so whichever merges second will probably need a rebase.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirm()}>Dispatch anyway</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      ) : null}
    </AlertDialog>
  )
}
