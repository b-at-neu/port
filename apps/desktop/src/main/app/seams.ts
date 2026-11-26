import type { ApplyItemActionParams, ItemActionResult } from '@/types/actions'
import type { BoardSnapshot } from '@/types/board'
import type { HostedStore } from '@/types/hosting'
import type { ReleaseBranchOutcome, RemoveSessionWorktreeOutcome } from '@/types/workspace'
import type { RegistryDeps } from '@/types/registry'
import type { RunStore, StageAllowIo, StageLauncherHandle } from '@/types/stage'
import type { Dispatcher, RepoDispatchStatus } from '@/types/dispatch'
import type { ForceDispatch } from '@/types/tick'
import type { ReposListResponse } from '@/types/ipc'
import type { ReadWorktreeReportParams, WorktreesReport } from '@/types/reclaimer'

export interface StageChannelDeps {
  readonly listRepositories: (deps: RegistryDeps) => Promise<ReposListResponse>
  readonly runs: RunStore
  readonly dispatcher: Pick<Dispatcher, 'status' | 'clearDenialsFor' | 'dismissDenial'>
  readonly store: Pick<HostedStore, 'list' | 'capacity'>
  readonly launcher: Pick<StageLauncherHandle, 'resume'>
  readonly removeWorktree: (path: string, force: boolean) => Promise<RemoveSessionWorktreeOutcome>
  readonly releaseBranch: (root: string, branch: string, baseSha: string) => Promise<ReleaseBranchOutcome>
  readonly applyItemAction: (params: ApplyItemActionParams) => Promise<ItemActionResult>
  readonly snapshot: () => BoardSnapshot
  readonly auditDir: string
  readonly scratchDir: string
  readonly allow: StageAllowIo
}

/** The seam `'held.forceDispatch'` composes through. `dispatcherStatus` reads the same `RepoDispatchStatus.owner` the board already renders, never a second ownership read. */
export interface HeldChannelDeps {
  readonly snapshot: () => BoardSnapshot
  readonly dispatcherStatus: () => readonly RepoDispatchStatus[]
  readonly forceDispatch: ForceDispatch
  /** The watcher's own republish — picks up the override immediately, never waiting for the next poll. */
  readonly republish: () => void
}

/** The seam `'worktrees.report'` composes through. */
export interface WorktreesReportDeps {
  readonly listRepositories: (deps: RegistryDeps) => Promise<ReposListResponse>
  readonly readWorktreeReport: (params: ReadWorktreeReportParams) => Promise<WorktreesReport>
}
