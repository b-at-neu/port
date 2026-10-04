// Operator control over dispatch (#110, #314): the header's Halt everything
// button and the halt report rendered under the tick strip — per-repository
// run/drain/pause now lives in `board/run-state.ts`. #265 adds the dispatch
// claim's own Take/Release button and the relay's own "Send to agent".
// `main.ts` delegates one `dispatch-*` click branch here rather than owning
// this state itself, the same split `board/actions.ts` draws for the
// board's own per-item actions.
import type { BoardSnapshot } from '../../../shared/board/types'
import type { HaltReport } from '../../../shared/dispatch/types'
import type { RepoId } from '../../../shared/repos'
import { haltAbortedCopy, haltHeadingCopy, haltItemLine } from './halt-copy'
import { handleRelaySend, relayKeyOf } from './relay'
import { handleRunStateClick } from './run-state'

type PendingCommand = 'halt' | null

let pending: PendingCommand = null
let haltConfirmArmed = false
let lastHaltReport: HaltReport | null = null

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

/** First click arms the confirm step (`Halt N items?`); the pending label
 *  takes over once the second click actually runs it. */
export function haltButtonLabel(inFlightCount: number): string {
  if (pending === 'halt') return 'Halting…'
  return haltConfirmArmed ? `Halt ${String(inFlightCount)} items?` : 'Halt everything'
}

async function runHalt(redraw: () => void): Promise<void> {
  pending = 'halt'
  redraw()
  try {
    const result = await window.port.dispatchControl({ command: 'halt' })
    if (result.command === 'halt') lastHaltReport = result.report
  } catch (error) {
    console.error('Failed to reach the main process for dispatch halt', error)
  }
  pending = null
  redraw()
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
  void runHalt(redraw)
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

// `haltItemLine`/`haltHeadingCopy`/`haltAbortedCopy` live in `./halt-copy`
// now, shared with `board/run-state.ts`'s own per-repository pause report —
// re-exported here since `view.ts` and this module's own `dispatch.test.ts`
// still import them from `./dispatch`.
export { haltAbortedCopy, haltHeadingCopy, haltItemLine }

/** The halt report's whole DOM, rendered under the tick strip until
 *  dismissed (`data-action="dispatch-halt-cancel"`, the same action the
 *  confirm step's own Cancel button uses, wired through `main.ts`'s one
 *  delegated click listener). `aborted` never lists an item — the run-state
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
  note.textContent = 'Every pipeline is paused. Nothing will be picked up until you run it again.'
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

/** #265: the claim take/release button's own click — the target state is
 *  the button's own action, never a toggle read off the current line (the
 *  same "never a toggle this channel infers" rule `gate:claim:set` already
 *  follows), so a stale render can only ever ask for the state its own
 *  label showed. */
async function runClaimSet(repoId: RepoId, held: boolean, redraw: () => void): Promise<void> {
  try {
    await window.port.dispatchClaimSet({ repoId, held })
  } catch (error) {
    console.error(`Failed to ${held ? 'take' : 'release'} the dispatch claim for '${repoId}'`, error)
  }
  redraw()
}

/**
 * The one `dispatch-*` click branch `main.ts` delegates every such action
 * to — the per-repository run/drain/pause row (#314), halt, halt-cancel, the
 * claim's own take/release (#265), and the relay's own "Send to agent"
 * (#265). A click naming a repository or a relay this app cannot resolve
 * from `target.dataset` and `snapshot` is silently ignored, the same
 * fail-safe every other board control already applies to a stale render.
 */
export function handleDispatchClick(target: HTMLElement, snapshot: BoardSnapshot | null, redraw: () => void): void {
  const action = target.dataset.action
  if (action === 'dispatch-run' || action === 'dispatch-drain' || action === 'dispatch-pause' || action === 'dispatch-pause-cancel') {
    const repoId = target.dataset.repoId
    if (repoId === undefined) return
    const inFlightCount = snapshot?.tick.find((report) => String(report.repoId) === repoId)?.claims.length ?? 0
    handleRunStateClick(action, repoId as RepoId, inFlightCount, redraw)
    return
  }
  if (action === 'dispatch-halt') {
    handleHaltClick(redraw)
    return
  }
  if (action === 'dispatch-halt-cancel') {
    handleHaltCancel(redraw)
    return
  }
  if (action === 'dispatch-claim-take' || action === 'dispatch-claim-release') {
    const repoId = target.dataset.repoId
    if (repoId === undefined) return
    void runClaimSet(repoId as RepoId, action === 'dispatch-claim-take', redraw)
    return
  }
  if (action === 'dispatch-relay-send') {
    const key = target.dataset.key
    const repoId = target.dataset.repoId
    if (key === undefined || repoId === undefined || snapshot === null || !snapshot.relay.ok) return
    const pending = snapshot.relay.pending.find((p) => relayKeyOf(p) === key)
    if (pending === undefined) return
    void handleRelaySend(pending, repoId as RepoId, redraw)
  }
}
