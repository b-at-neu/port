// Which forced reclaim, if any, a worktree row offers. Pure, no DOM.
import type { ForcedFlags, InspectedWorktree, WorktreesReport } from '@/types/reclaimer'

// Only decides which button to show — the script re-classifies the path on the run, and an unknown dirty count counts as dirty.
export function forcedReclaimFor(worktree: InspectedWorktree, report: Extract<WorktreesReport, { ok: true }>): ForcedFlags | null {
  if (report.forcedActions !== 'supported' || !worktree.otherwiseReclaimable) return null
  if (worktree.state === 'locked') return { unlock: true, forceDirty: worktree.dirtyFiles !== 0 }
  if (worktree.state === 'dirty') return { unlock: false, forceDirty: true }
  return null
}
