// The public surface #79 imports — never `./worktrees`, `./denials`, or
// `../platform/git` directly. This directory never calls `gh` and resolves
// no item state (Decision 1); joining a worktree or a denial to an item's
// `gh`-resolved state is #79's own job.
export { correlate } from './correlate'
export type { CorrelationInput } from './correlate'

export { readWorktrees } from './worktrees'
export type { GitRunner as WorktreesGitRunner, ReadWorktreesParams } from './worktrees'

export { readDenials } from './denials'
export type { GitRunner as DenialsGitRunner, ReadDenialsParams } from './denials'

export type {
  CorrelationRung,
  DenialActor,
  DenialDecision,
  DenialEntry,
  DenialForm,
  DenialsFailureKind,
  DenialsRead,
  DenialSummary,
  LocalFailureKind,
  UnresolvedReason,
  WorktreeCorrelation,
  WorktreeEntry,
  WorktreeProducer,
  WorktreesRead,
} from '../../shared/local/types'
