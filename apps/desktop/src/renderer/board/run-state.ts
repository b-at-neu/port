// Per-repository run-state copy; `app/run-state.ts` drives the mutation.
import type { DispatchControlResult, HaltReport, RepoRunState, RunState, RunStatesSnapshot } from '@/types/dispatch'
import { formatShortTime } from '@/renderer/lib/time'

/** The row's store-aware line; the two store-level states override the repository's own persisted state. */
export function runStateLineCopy(repoRunState: RepoRunState, store: RunStatesSnapshot['store']): string {
  if (store.kind === 'unread') return 'Stopped — reading the saved pipeline state…'
  if (store.kind === 'unreadable') return `Stopped — dispatch.json can't be read (${store.message}). Fix or delete it, then run it again.`

  const { state, since } = repoRunState
  if (state === 'dispatching') return since !== null ? `Running since ${formatShortTime(since)}` : 'Running'
  if (state === 'draining') return since !== null ? `Draining since ${formatShortTime(since)} — work in progress finishes, nothing new starts` : 'Draining — work in progress finishes, nothing new starts'
  return since !== null ? `Stopped since ${formatShortTime(since)} — nothing dispatches` : 'Stopped — press Run to start dispatching'
}

function ownershipRefusalNote(message: string | undefined): string {
  return `Stays stopped: its ownership record can't be read (${message}). Fix or delete it, then run it again.`
}

/** The line shown once a run or drain result needs attention; `null` for an ordinary success. A pause renders as a stop report instead. */
export function runStateResultNote(result: DispatchControlResult): string | null {
  if (result.command === 'run') {
    if (result.ok) return null
    if (result.reason === 'ownership-unreadable') return ownershipRefusalNote(result.message)
    if (result.reason === 'unwritable') return `Couldn't run: ${result.path} couldn't be written (${result.message}). It's still stopped.`
    return `Stays stopped: dispatch.json can't be read (${result.message}). Fix or delete it, then run it again.`
  }
  if (result.command === 'drain') {
    if (!result.ok) {
      if (result.reason === 'ownership-unreadable') return ownershipRefusalNote(result.message)
      return `Stays stopped: dispatch.json can't be read (${result.message}). Fix or delete it, then run it again.`
    }
    return result.persisted ? null : "Draining, but it wasn't saved to disk, so it won't survive a restart."
  }
  return null
}

/** The command that restores the state a run/drain just left, or `null` when it was not a reversible step. */
export function undoCommandFor(prior: RunState | null, command: 'run' | 'drain'): 'run' | 'drain' | 'pause' | null {
  if (command === 'run') {
    if (prior === 'draining') return 'drain'
    if (prior === 'paused') return 'pause'
    return null
  }
  return prior === 'dispatching' ? 'run' : null
}

export function pauseReportNote(report: Extract<HaltReport, { readonly kind: 'completed' }>, repoName: string): string {
  return `Nothing in ${repoName} will be picked up until you run it. Stopped tickets have no stage; Resume on a row restores it.`
}

export function pauseAbortedCopy(report: Extract<HaltReport, { readonly kind: 'aborted' }>): string {
  return `Nothing was stopped — ${report.path} couldn't be written (${report.message}). Labels were left alone.`
}
