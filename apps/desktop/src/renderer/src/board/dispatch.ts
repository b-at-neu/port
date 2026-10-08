// Operator control over dispatch (#110, #314, #319): the header's Halt
// everything request and the halt report rendered under the pipeline status
// strip — per-repository run/drain/pause lives in `board/run-state.ts`. The
// two-click arm step is gone: `header.tsx`'s shadcn `AlertDialog` is the
// confirmation now, so this module only runs the request once the dialog's
// own confirm button is pressed. #331's Take over is a plain async function,
// called directly from `pipeline-status.tsx`'s own button — no DOM click
// delegation, and `window.confirm` rather than a second `AlertDialog`, the
// same idiom this owner line already used for the claim button it replaces.
import type { HaltReport } from '../../../shared/dispatch/types'
import type { RepoId } from '../../../shared/repos'
import { haltAbortedCopy, haltHeadingCopy, haltItemLine } from './halt-copy'

type PendingCommand = 'halt' | null

let pending: PendingCommand = null
let lastHaltReport: HaltReport | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** `useSyncExternalStore`'s own subscribe half for `haltPending`/
 *  `currentHaltReport`. */
export function subscribeDispatch(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function haltPending(): boolean {
  return pending === 'halt'
}

/** `header.tsx`'s own lookup for the halt report banner — `null` once
 *  dismissed, or before any halt has ever run this session. */
export function currentHaltReport(): HaltReport | null {
  return lastHaltReport
}

/** No arm step to pair with any more — `header.tsx`'s own `AlertDialog`
 *  open state is the confirmation, so this reads only `haltPending()`. */
export function haltButtonLabel(pending: boolean): string {
  return pending ? 'Halting…' : 'Halt everything'
}

/** The `AlertDialog`'s own confirm action. */
export async function runHalt(): Promise<void> {
  pending = 'halt'
  notify()
  try {
    const result = await window.port.dispatchControl({ command: 'halt' })
    if (result.command === 'halt') lastHaltReport = result.report
  } catch (error) {
    console.error('Failed to reach the main process for dispatch halt', error)
  }
  pending = null
  notify()
}

/** The halt report banner's own Dismiss button. */
export function dismissHaltReport(): void {
  lastHaltReport = null
  notify()
}

// `haltItemLine`/`haltHeadingCopy`/`haltAbortedCopy` live in `./halt-copy`
// now, shared with `board/run-state.ts`'s own per-repository pause report —
// re-exported here since `header.tsx` and this module's own `dispatch.test.ts`
// still import them from `./dispatch`.
export { haltAbortedCopy, haltHeadingCopy, haltItemLine }

/** #331: the owner line's own Take over button, called directly from
 *  `pipeline-status.tsx`. `window.confirm` is the confirmation — no local
 *  `notify()`: a successful write is picked up by the board's next regular
 *  poll, the same as every other dispatch-status field. */
export async function takeOver(repoId: RepoId, repoName: string): Promise<void> {
  const confirmed = window.confirm(
    `Take over ${repoName} from the terminal?\n\nOnly do this if /port:pipeline isn't running for this repo in any terminal. This app can't tell whether it is. A cockpit still running there stops at its next tick.`,
  )
  if (!confirmed) return
  try {
    await window.port.dispatchControl({ command: 'take-over', repoId })
  } catch (error) {
    console.error(`Failed to take over '${repoId}'`, error)
  }
}
