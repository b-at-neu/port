// Operator control over dispatch (#110): the header's Drain/Resume toggle
// and Halt everything button, and the halt report rendered under the tick
// strip. `main.ts` delegates its three click branches here rather than
// owning this state itself, the same split `board/actions.ts` draws for the
// board's own per-item actions.
import type { DispatchControlResult, DrainState, HaltItemOutcome, HaltReport } from '../../../shared/dispatch/types'
import { actionResultCopy } from './copy'

type PendingCommand = 'drain' | 'resume' | 'halt' | null

/** The two commands `currentDrainResult`/`drainResultNote` care about —
 *  `halt`'s own report keeps its separate `lastHaltReport` slot below,
 *  unchanged. */
type DrainCommandResult = Extract<DispatchControlResult, { readonly command: 'drain' } | { readonly command: 'resume' }>

let pending: PendingCommand = null
let haltConfirmArmed = false
let lastHaltReport: HaltReport | null = null
let lastDrainResult: DrainCommandResult | null = null

export function drainTogglePending(): boolean {
  return pending === 'drain' || pending === 'resume'
}

export function haltPending(): boolean {
  return pending === 'halt'
}

export function isHaltConfirmArmed(): boolean {
  return haltConfirmArmed
}

/** `view.ts`'s own lookup for the halt report banner — `null` once
 *  dismissed, or before any halt has ever run this session. */
export function currentHaltReport(): HaltReport | null {
  return lastHaltReport
}

/** `view.ts`'s own lookup for the drain/resume result note, rendered near
 *  the drain toggle — `null` before either command has ever run this
 *  session, and overwritten (never accumulated) by every later attempt, so
 *  a subsequent success clears whatever the previous failure left showing. */
export function currentDrainResult(): DrainCommandResult | null {
  return lastDrainResult
}

/** gate open → `Drain` · pending `Draining…`; gate closed → `Resume
 *  dispatch` · pending `Resuming…` (plan's own **UX states**). */
export function drainToggleLabel(drain: DrainState): string {
  if (pending === 'drain') return 'Draining…'
  if (pending === 'resume') return 'Resuming…'
  return drain.gate === 'open' ? 'Drain' : 'Resume dispatch'
}

/** First click arms the confirm step (`Halt N items?`); the pending label
 *  takes over once the second click actually runs it. */
export function haltButtonLabel(inFlightCount: number): string {
  if (pending === 'halt') return 'Halting…'
  return haltConfirmArmed ? `Halt ${String(inFlightCount)} items?` : 'Halt everything'
}

async function runDispatchCommand(command: 'drain' | 'resume' | 'halt', redraw: () => void): Promise<void> {
  pending = command
  redraw()
  try {
    const result = await window.port.dispatchControl({ command })
    if (result.command === 'halt') lastHaltReport = result.report
    else lastDrainResult = result
  } catch (error) {
    console.error(`Failed to reach the main process for dispatch ${command}`, error)
  }
  pending = null
  redraw()
}

/** The header's own single toggle — drains when the gate is open, resumes
 *  when it is closed. A click while another command is already pending is
 *  ignored, the same one-in-flight guard `board/actions.ts` applies to a
 *  row's own action strip. */
export function handleDrainToggle(drain: DrainState, redraw: () => void): void {
  if (pending !== null) return
  void runDispatchCommand(drain.gate === 'open' ? 'drain' : 'resume', redraw)
}

/** First click arms the confirm step; a second click while armed runs the
 *  halt. `handleHaltCancel` disarms without a round trip. */
export function handleHaltClick(redraw: () => void): void {
  if (pending !== null) return
  if (!haltConfirmArmed) {
    haltConfirmArmed = true
    redraw()
    return
  }
  haltConfirmArmed = false
  void runDispatchCommand('halt', redraw)
}

/** One data-action, `dispatch-halt-cancel`, shared by the confirm step's own
 *  Cancel button and the halt report's Dismiss button — the two are never
 *  visible at once (a fresh halt disarms the confirm step by construction),
 *  so one handler unarming the confirm step and clearing the last report
 *  covers both without a fourth click branch in `main.ts`. */
export function handleHaltCancel(redraw: () => void): void {
  haltConfirmArmed = false
  lastHaltReport = null
  redraw()
}

/** The one line rendered near the drain toggle once a drain/resume command's
 *  own result needs the operator's attention — `null` for an ordinary
 *  success, since `tick.ts`'s own `drainLineFor` already covers the
 *  persisted state on every later read. A failed drain write still closed
 *  the gate in memory (`persisted: false`, plan's own **Data & contracts**:
 *  "a resume that did not persist... reports that the state will not
 *  survive a restart"); a refused resume changed nothing at all. */
export function drainResultNote(result: DrainCommandResult): string | null {
  if (result.command === 'drain') {
    if (result.persisted) return null
    return "Drain applied, but wasn't saved to disk — it won't survive a restart."
  }
  if (result.ok) return null
  return `Resume refused — ${result.path} couldn't be written (${result.message}). Dispatch is still draining.`
}

function skippedLine(outcome: Extract<HaltItemOutcome, { readonly kind: 'skipped' }>): string {
  const n = String(outcome.number)
  switch (outcome.reason) {
    case 'session-required':
      return `#${n} skipped — session required; your own /port:implement session owns it.`
    case 'not-owned':
      return `#${n} skipped — @${outcome.owner ?? 'someone else'} owns it.`
    case 'viewer-unknown':
      return `#${n} skipped — can't tell which account you're signed in as.`
  }
}

/** One line per outcome (plan's own **UX states**) — a stopped item names
 *  what this app removed and, when one exists, the agent or session it
 *  found still attached (this app cannot stop one — #106's job); a refused
 *  item reuses the ordinary row action's own result copy rather than a
 *  second wording for the same `ItemActionResult`. */
export function haltItemLine(outcome: HaltItemOutcome, now: Date): string {
  const n = String(outcome.number)
  switch (outcome.kind) {
    case 'stopped': {
      const attached = outcome.attachedAgent !== null ? ` ${outcome.attachedAgent} still attached — this app can't stop it.` : ''
      return `#${n} ${outcome.removedLabel} → no stage.${attached}`
    }
    case 'skipped':
      return skippedLine(outcome)
    case 'refused':
      return `#${n} not stopped — ${actionResultCopy({ action: 'stop', number: outcome.number, plan: null, currentStageName: null, result: outcome.result, now })}`
  }
}

/** The heading line for a `completed` report — `N stopped, M skipped`, plus
 *  a `, K not stopped` clause only when a refusal actually happened, so the
 *  ordinary case stays exactly the two-count example the plan itself gives. */
export function haltHeadingCopy(report: Extract<HaltReport, { readonly kind: 'completed' }>): string {
  const stopped = report.items.filter((item) => item.kind === 'stopped').length
  const skipped = report.items.filter((item) => item.kind === 'skipped').length
  const refused = report.items.filter((item) => item.kind === 'refused').length
  const refusedPart = refused > 0 ? `, ${String(refused)} not stopped` : ''
  return `Halted · ${String(stopped)} stopped, ${String(skipped)} skipped${refusedPart}`
}

/** The one line an `aborted` report ever shows — the drain write itself
 *  failed, so nothing was touched and none of the copy above ever runs. */
export function haltAbortedCopy(report: Extract<HaltReport, { readonly kind: 'aborted' }>): string {
  return `Nothing was halted — ${report.path} couldn't be written (${report.message}). Labels were left alone, because resetting them with dispatch still open would just start everything again.`
}

/** The halt report's whole DOM, rendered under the tick strip until
 *  dismissed (`data-action="dispatch-halt-cancel"`, the same action the
 *  confirm step's own Cancel button uses, wired through `main.ts`'s one
 *  delegated click listener). `aborted` never lists an item — the drain
 *  write itself failed, so nothing was touched. */
export function buildHaltReport(report: HaltReport, now: Date): HTMLElement {
  const section = document.createElement('div')
  section.className = 'board-halt'

  const dismiss = document.createElement('button')
  dismiss.className = 'board-halt__dismiss'
  dismiss.dataset.action = 'dispatch-halt-cancel'
  dismiss.textContent = 'Dismiss'

  if (report.kind === 'aborted') {
    section.appendChild(document.createTextNode(haltAbortedCopy(report)))
    section.appendChild(dismiss)
    return section
  }

  const heading = document.createElement('div')
  heading.className = 'board-halt__heading'
  heading.textContent = haltHeadingCopy(report)
  section.appendChild(heading)

  const note = document.createElement('div')
  note.className = 'board-halt__note'
  note.textContent = 'Dispatch is draining. Nothing will be picked up until you resume.'
  section.appendChild(note)

  for (const outcome of report.items) {
    const line = document.createElement('div')
    line.className = 'board-halt__line'
    line.textContent = haltItemLine(outcome, now)
    section.appendChild(line)
  }

  section.appendChild(dismiss)
  return section
}
