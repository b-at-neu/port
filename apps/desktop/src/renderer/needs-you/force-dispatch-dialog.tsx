// "Dispatch anyway"'s own confirmation — DESIGN §4: it has consequences (both agents can edit the
// same files at once).
import { useSyncExternalStore } from 'react'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/renderer/components/ui/alert-dialog'
import { useQueryClient } from '@tanstack/react-query'
import type { TickHeld } from '@/types/tick'
import type { ActionToast } from '@/types/toast'
import type { RepoId } from '@/utils/repos'
import type { HeldForceDispatchResult } from '@/types/dispatch'
import { invoke } from '@/renderer/data/invoke'
import { runInBackground } from '@/renderer/lib/background-action'
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

function resultToast(number: number, result: HeldForceDispatchResult): ActionToast {
  const plain = { description: null, action: null, cancel: null } as const
  switch (result.kind) {
    case 'ok':
      return { ...plain, tone: 'success', title: `#${String(number)} will dispatch on the next tick.` }
    case 'not-held':
      return { ...plain, tone: 'info', title: `#${String(number)} isn't held anymore. Nothing to force.` }
    case 'not-owned':
      return { ...plain, tone: 'error', title: `This app doesn't run that repository, so it can't dispatch #${String(number)}.` }
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
    close()
    await runInBackground({
      id: `force-dispatch:${repoId}:${String(number)}`,
      pending: `Dispatching #${String(number)}…`,
      run: () => invoke('held:force-dispatch', { repoId, number }),
      toToast: (result) => resultToast(number, result),
    })
    void queryClient.invalidateQueries({ queryKey: ipcQueryOptions('board:snapshot').queryKey })
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
