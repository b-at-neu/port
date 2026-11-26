import type { RegistryDeps } from '@/types/registry'
import type { StageAllowIo } from '@/types/stage'
import type { Dispatcher } from '@/types/dispatch'
import type { ReposListResponse } from '@/types/ipc'
import type { ReadWorktreeReportParams, WorktreesReport } from '@/types/reclaimer'

export interface StageChannelDeps {
  readonly listRepositories: (deps: RegistryDeps) => Promise<ReposListResponse>
  readonly dispatcher: Pick<Dispatcher, 'status' | 'clearDenialsFor' | 'dismissDenial'>
  readonly auditDir: string
  readonly scratchDir: string
  readonly allow: StageAllowIo
}

/** The seam `'worktrees.report'` composes through. */
export interface WorktreesReportDeps {
  readonly listRepositories: (deps: RegistryDeps) => Promise<ReposListResponse>
  readonly readWorktreeReport: (params: ReadWorktreeReportParams) => Promise<WorktreesReport>
}
