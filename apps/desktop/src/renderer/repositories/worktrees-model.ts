// Which forced reclaim, if any, a worktree row offers. Pure, no DOM.
import type { ForcedFlags, InspectedWorktree } from '@/types/reclaimer'

// Only decides which button to show — the run re-classifies the path, and an unknown dirty count counts as dirty.
export function forcedReclaimFor(worktree: InspectedWorktree): ForcedFlags | null {
  if (!worktree.otherwiseReclaimable) return null
  if (worktree.state === 'locked') return { unlock: true, forceDirty: worktree.dirtyFiles !== 0 }
  if (worktree.state === 'dirty') return { unlock: false, forceDirty: true }
  return null
}
