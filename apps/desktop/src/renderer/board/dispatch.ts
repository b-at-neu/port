// Operator control over dispatch (#331): Take over, called directly from
// `pipeline-status.tsx`'s own button. Halt everything is gone;
// per-repository run/drain/pause lives in `board/run-state.ts`.
import type { RepoId } from '@/utils/repos'

/** `window.confirm` is the confirmation — no local `notify()`: a successful
 *  write is picked up by the board's next regular poll, the same as every
 *  other dispatch-status field. */
export async function takeOver(repoId: RepoId, repoName: string): Promise<void> {
  const confirmed = window.confirm(
    `Take over ${repoName} from the terminal?\n\nOnly do this once /port:pipeline has stopped for this repo in every terminal. This app can't confirm that itself. A cockpit still active there stops at its next tick.`,
  )
  if (!confirmed) return
  try {
    await window.port.dispatchControl({ command: 'take-over', repoId })
  } catch (error) {
    console.error(`Failed to take over '${repoId}'`, error)
  }
}
