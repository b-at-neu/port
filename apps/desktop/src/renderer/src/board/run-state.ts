// Per-repository run state (#314, replacing #110's single global drain
// toggle): one row under each ready repository's own tick line, with Run/
// Drain/Pause buttons. `main.ts` routes every `dispatch-*` click to
// `board/dispatch.ts`'s `handleDispatchClick`, which delegates the
// run/drain/pause/pause-cancel actions here — the same split that module
// already draws for halt.
import type { DispatchControlResult, HaltReport, RepoRunState, RunStatesSnapshot } from '../../../shared/dispatch/types'
import type { RepoId } from '../../../shared/repos'
import { haltHeadingCopy, haltItemLine } from './halt-copy'

type RunCommand = 'run' | 'drain' | 'pause'

const pendingByRepo = new Map<RepoId, RunCommand>()
const pauseConfirmArmed = new Set<RepoId>()
const lastResultByRepo = new Map<RepoId, DispatchControlResult>()

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

export function runButtonLabel(repoId: RepoId): string {
  return pendingByRepo.get(repoId) === 'run' ? 'Starting…' : 'Run'
}

export function drainButtonLabel(repoId: RepoId): string {
  return pendingByRepo.get(repoId) === 'drain' ? 'Draining…' : 'Drain'
}

/** First click arms the confirm step (`Pause and stop N?`) only when this
 *  repository has at least one in-flight claim; with zero in flight, pause
 *  applies at once (plan's own **UX states**). */
export function pauseButtonLabel(repoId: RepoId, inFlightCount: number): string {
  if (pendingByRepo.get(repoId) === 'pause') return 'Pausing…'
  return pauseConfirmArmed.has(repoId) ? `Pause and stop ${String(inFlightCount)}?` : 'Pause'
}

export function isPauseConfirmArmed(repoId: RepoId): boolean {
  return pauseConfirmArmed.has(repoId)
}

export function runStatePending(repoId: RepoId): boolean {
  return pendingByRepo.has(repoId)
}

export function currentRunStateResult(repoId: RepoId): DispatchControlResult | null {
  return lastResultByRepo.get(repoId) ?? null
}

/** The one line rendered near the row once a run/drain command's own result
 *  needs the operator's attention — `null` for an ordinary success, since
 *  `runStateLineCopy` already covers the persisted state on every later
 *  read. `pause`'s own result renders as a stop report instead
 *  (`buildPauseReport`), never through this line. */
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

/** `pause`'s own stop report, reusing `dispatch.ts`'s halt copy — the same
 *  shape as `Halt everything`'s report, scoped to one repository, with the
 *  run-state-specific note this plan's **UX states** table names. */
export function pauseReportNote(report: Extract<HaltReport, { readonly kind: 'completed' }>, repoName: string): string {
  return `Nothing in ${repoName} will be picked up until you run it. Stopped tickets have no stage; Resume on a row restores it.`
}

export function pauseAbortedCopy(report: Extract<HaltReport, { readonly kind: 'aborted' }>): string {
  return `Nothing was paused — ${report.path} couldn't be written (${report.message}). Labels were left alone.`
}

async function sendDispatchCommand(command: RunCommand, repoId: RepoId, redraw: () => void): Promise<void> {
  pendingByRepo.set(repoId, command)
  redraw()
  try {
    const result = await window.port.dispatchControl({ command, repoId })
    lastResultByRepo.set(repoId, result)
  } catch (error) {
    console.error(`Failed to reach the main process for dispatch ${command} on '${String(repoId)}'`, error)
  }
  pendingByRepo.delete(repoId)
  redraw()
}

/** Run/Drain apply at once; Pause arms a confirm step only when this
 *  repository currently has at least one in-flight claim. */
export function handleRunStateClick(action: string, repoId: RepoId, inFlightCount: number, redraw: () => void): void {
  if (pendingByRepo.has(repoId)) return
  if (action === 'dispatch-run') {
    void sendDispatchCommand('run', repoId, redraw)
    return
  }
  if (action === 'dispatch-drain') {
    void sendDispatchCommand('drain', repoId, redraw)
    return
  }
  if (action === 'dispatch-pause') {
    if (inFlightCount > 0 && !pauseConfirmArmed.has(repoId)) {
      pauseConfirmArmed.add(repoId)
      redraw()
      return
    }
    pauseConfirmArmed.delete(repoId)
    void sendDispatchCommand('pause', repoId, redraw)
    return
  }
  if (action === 'dispatch-pause-cancel') {
    pauseConfirmArmed.delete(repoId)
    redraw()
  }
}

/** One repository's own run-state row, rendered under its tick line —
 *  `view.ts`/`tick.ts` call this once per ready repository, the same way
 *  `owner.ts`'s own `buildOwnerLine` already is. */
export function buildRunStateRow(repoRunState: RepoRunState, store: RunStatesSnapshot['store'], repoName: string, inFlightCount: number): HTMLElement {
  const row = document.createElement('div')
  row.className = 'board-header__run-state-row'

  const text = document.createElement('span')
  text.className = 'board-header__run-state-text'
  text.textContent = runStateLineCopy(repoRunState, store)
  row.appendChild(text)

  const storeDisabled = store.kind !== 'loaded'
  const repoId = repoRunState.repoId

  const runButton = document.createElement('button')
  runButton.className = 'board-header__run-state-button'
  runButton.dataset.action = 'dispatch-run'
  runButton.dataset.repoId = String(repoId)
  runButton.textContent = runButtonLabel(repoId)
  runButton.disabled = runStatePending(repoId) || storeDisabled
  if (store.kind === 'unreadable') runButton.title = "dispatch.json can't be read"
  row.appendChild(runButton)

  const drainButton = document.createElement('button')
  drainButton.className = 'board-header__run-state-button'
  drainButton.dataset.action = 'dispatch-drain'
  drainButton.dataset.repoId = String(repoId)
  drainButton.textContent = drainButtonLabel(repoId)
  drainButton.disabled = runStatePending(repoId) || storeDisabled
  if (store.kind === 'unreadable') drainButton.title = "dispatch.json can't be read"
  row.appendChild(drainButton)

  const pauseButton = document.createElement('button')
  pauseButton.className = 'board-header__run-state-button'
  pauseButton.dataset.action = 'dispatch-pause'
  pauseButton.dataset.repoId = String(repoId)
  pauseButton.textContent = pauseButtonLabel(repoId, inFlightCount)
  pauseButton.disabled = runStatePending(repoId)
  row.appendChild(pauseButton)

  if (isPauseConfirmArmed(repoId)) {
    const cancelButton = document.createElement('button')
    cancelButton.className = 'board-header__run-state-button'
    cancelButton.dataset.action = 'dispatch-pause-cancel'
    cancelButton.dataset.repoId = String(repoId)
    cancelButton.textContent = 'Cancel'
    row.appendChild(cancelButton)
  }

  const result = currentRunStateResult(repoId)
  if (result !== null) {
    if (result.command === 'pause') {
      const pauseNote = document.createElement('div')
      pauseNote.className = 'board-header__run-state-note'
      if (result.report.kind === 'aborted') {
        pauseNote.textContent = pauseAbortedCopy(result.report)
      } else {
        const heading = haltHeadingCopy(result.report)
        const lines = result.report.items.map((item) => haltItemLine(item, new Date()))
        pauseNote.textContent = [heading, pauseReportNote(result.report, repoName), ...lines].join(' — ')
      }
      row.appendChild(pauseNote)
    } else {
      const note = runStateResultNote(result)
      if (note !== null) {
        const noteEl = document.createElement('div')
        noteEl.className = 'board-header__run-state-note'
        noteEl.textContent = note
        row.appendChild(noteEl)
      }
    }
  }

  return row
}
