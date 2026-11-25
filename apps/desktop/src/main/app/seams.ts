import type { ApplyItemActionParams, ItemActionResult } from '@/types/actions'
import type { BoardSnapshot } from '@/types/board'
import type { HostedStore, SessionStartTarget, SessionStartMode } from '@/types/hosting'
import type { Platform } from '@/main/platform'
import type { StartTargetSources, ReleaseBranchOutcome, RemoveSessionWorktreeOutcome, ResolvedStartTarget } from '@/types/workspace'
import type { FileResult } from '@/types/platform'

type FileListingResult = { readonly ok: true; readonly files: readonly string[]; readonly truncated: boolean } | { readonly ok: false; readonly message: string }
import type { RegistryDeps } from '@/types/registry'
import type { SessionIndex } from '@/types/session-index'
import type { ReadSessionStateParams, SessionScan, TranscriptTailStore } from '@/types/sessions'
import type { RunSearchParams, SearchResult } from '@/types/search'
import type { RunStore, StageAllowIo, StageLauncherHandle } from '@/types/stage'
import type { Dispatcher, RepoDispatchStatus } from '@/types/dispatch'
import type { ForceDispatch } from '@/types/tick'
import type { ReposListResponse } from '@/types/ipc'
import type { NeedsYouNotification, NotificationPrefs } from '@/types/settings'
import type { ReadWorktreeReportParams, WorktreesReport } from '@/types/reclaimer'

export interface HostingChannelDeps {
  readonly listRepositories: (deps: RegistryDeps) => Promise<ReposListResponse>
  readonly store: HostedStore
  readonly sessionIndex: SessionIndex
  readonly listSessionFiles: (cwd: string) => Promise<FileListingResult>
  readonly resolveStartTarget: (ctx: Pick<Platform, 'git' | 'fs'>, target: SessionStartTarget, mode: SessionStartMode, sources: StartTargetSources) => Promise<ResolvedStartTarget>
  readonly targetCtx: Pick<Platform, 'git' | 'fs'>
  readonly targetSources: Omit<StartTargetSources, 'repositories'>
  readonly now: () => Date
  /** Best-effort cleanup for a worktree created ahead of a start that then failed — logged, never surfaced over the start result. */
  readonly removeCreatedWorktree: (path: string) => Promise<void>
}

export interface TranscriptTailDeps {
  readonly openTail: TranscriptTailStore['openTail']
  readonly pollTail: TranscriptTailStore['pollTail']
  readonly closeTail: TranscriptTailStore['closeTail']
}

export interface SessionsScanDeps {
  readonly listRepositories: (deps: RegistryDeps) => Promise<ReposListResponse>
  readonly readSessionState: (params: Pick<ReadSessionStateParams, 'repos'>) => Promise<SessionScan>
}

export interface SearchQueryDeps {
  readonly resolveSessionsScan: (registryDeps: RegistryDeps) => Promise<SessionScan>
  readonly runSearch: (params: RunSearchParams) => Promise<SearchResult>
}

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

/** The seam `'notify.needsYou'` composes through — `show` owns the focus rule and the Electron notification. */
export interface NotifyChannelDeps {
  readonly show: (notification: NeedsYouNotification) => void
}

/** The seam `'notify.prefs'`/`'notify.prefsSet'` compose through — the hosted store's persisted preferences. */
export interface NotifyPrefsDeps {
  readonly prefs: () => Promise<NotificationPrefs>
  readonly setPrefs: (next: NotificationPrefs) => Promise<NotificationPrefs>
}

/** The seam `'worktrees.report'` composes through. */
export interface WorktreesReportDeps {
  readonly listRepositories: (deps: RegistryDeps) => Promise<ReposListResponse>
  readonly readWorktreeReport: (params: ReadWorktreeReportParams) => Promise<WorktreesReport>
}
