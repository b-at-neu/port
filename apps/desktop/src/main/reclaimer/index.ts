// The public surface the IPC layer imports — never `./command`, `./parse`,
// or `./report` directly. The classification behind `readWorktreeReport`
// comes from the shipped `bin/worktrees.mjs report --json`, never a
// second implementation here, and this directory never calls `git worktree`
// itself — `main/local/`'s join (via #77's own `readWorktrees`) is the one
// place that does. `parseNodeCommand` and `SCRIPT_FAIL_PREFIX` are reused by
// `dispatch/budget-gate.ts` (#293) — the tokenizer and the `FAIL` sentinel
// are never worktrees-specific.
export { readWorktreeReport, SCRIPT_FAIL_PREFIX } from './report'
export type { NodeRunner, ReadWorktreeReportParams } from './report'

export { parseNodeCommand } from './command'
export type { TokenizeResult } from './command'

export type {
  GithubResolutionState,
  InspectedWorktree,
  PorcelainJoinState,
  ReclaimableState,
  ReclaimerFailure,
  ReclaimerFailureKind,
  WorktreesReport,
  WorktreeState,
} from '../../shared/reclaimer/types'
export { isReclaimableState, RECLAIMABLE_STATES, WORKTREE_STATES } from '../../shared/reclaimer/types'
