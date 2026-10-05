// Per-repository run-state copy (#314, #316) — the row and its buttons move
// to `shell/sidebar-pipelines.tsx`'s `StatusPillMenu`, driven by
// `shell/run-state-command.ts`'s mutation instead of this file's own
// click-handler/pending-map pair. Only the pure copy survives here.
import type { DispatchControlResult, HaltReport, RepoRunState, RunStatesSnapshot } from '../../../shared/dispatch/types'

function timeOf(iso: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** The row's own store-aware line — "Running since 14:02", "Draining
 *  since…", "Paused since…", the new-repo variant with no `since` at all, or
 *  the two store-level overrides (`unread`/`unreadable`) that apply
 *  regardless of this repository's own persisted state. */
export function runStateLineCopy(repoRunState: RepoRunState, store: RunStatesSnapshot['store']): string {
  if (store.kind === 'unread') return 'Paused — reading the saved pipeline state…'
  if (store.kind === 'unreadable') return `Paused — dispatch.json can't be read (${store.message}). Fix or delete it, then run it again.`

  const { state, since } = repoRunState
  if (state === 'dispatching') return since !== null ? `Running since ${timeOf(since)}` : 'Running'
  if (state === 'draining') return since !== null ? `Draining since ${timeOf(since)} — work in progress finishes, nothing new starts` : 'Draining — work in progress finishes, nothing new starts'
  return since !== null ? `Paused since ${timeOf(since)} — nothing dispatches` : 'Paused — press Run to start dispatching'
}

/** The one line rendered near the row once a run/drain command's own result
 *  needs the operator's attention — `null` for an ordinary success, since
 *  `runStateLineCopy` already covers the persisted state on every later
 *  read. `pause`'s own result renders as a stop report instead
 *  (`pauseReportNote`/`pauseAbortedCopy`), never through this line. */
export function runStateResultNote(result: DispatchControlResult): string | null {
  if (result.command === 'run') {
    if (result.ok) return null
    if (result.reason === 'unwritable') return `Couldn't run: ${result.path} couldn't be written (${result.message}). It's still paused.`
    return `Stays paused: dispatch.json can't be read (${result.message}). Fix or delete it, then run it again.`
  }
  if (result.command === 'drain') {
    if (!result.ok) return `Stays paused: dispatch.json can't be read (${result.message}). Fix or delete it, then run it again.`
    return result.persisted ? null : "Draining, but it wasn't saved to disk, so it won't survive a restart."
  }
  return null
}

/** `pause`'s own stop report, reusing `halt-copy.ts`'s halt copy — the same
 *  shape as `Halt everything`'s report, scoped to one repository, with the
 *  run-state-specific note the plan's **UX states** table names. */
export function pauseReportNote(report: Extract<HaltReport, { readonly kind: 'completed' }>, repoName: string): string {
  return `Nothing in ${repoName} will be picked up until you run it. Stopped tickets have no stage; Resume on a row restores it.`
}

export function pauseAbortedCopy(report: Extract<HaltReport, { readonly kind: 'aborted' }>): string {
  return `Nothing was paused — ${report.path} couldn't be written (${report.message}). Labels were left alone.`
}
