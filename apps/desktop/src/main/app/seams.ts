import type { GatePreflightParams, GateAnswerParams, ApplyItemDecisionParams, ItemDecisionResult, ApplyItemActionParams, ItemActionResult } from '@/types/actions'
import type { GatePreflightResponse, GateAnswerResponse } from '@/types/gate'
import type { IncidentLog } from '@/types/incidents'
import type { BoardSnapshot, SourceKind } from '@/types/board'
import type { RepoId } from '@/utils/repos'
import type { HostedSessionSnapshot, HostedStore, SessionStartTarget, SessionStartMode } from '@/types/hosting'
import type { ResolveStartTargetDeps, ReleaseBranchOutcome, RemoveSessionWorktreeOutcome, ResolvedStartTarget } from '@/types/workspace'
import type { DirEntry, FileResult, GitLinesResult, RunCommandOptions } from '@/types/platform'

/** `main/sessions/hosting/files.ts`'s own injectable seam, inlined here since a `types/` file may not import a
 *  value from `main/` — this is the whole real shape, not an approximation. */
type FileListingDeps = {
  readonly gitLines: (args: readonly string[], options: Omit<RunCommandOptions, 'whichEnv' | 'platform'>) => Promise<GitLinesResult>
  readonly listDirectory: (path: string) => Promise<FileResult<readonly DirEntry[]>>
}
type FileListingResult = { readonly ok: true; readonly files: readonly string[]; readonly truncated: boolean } | { readonly ok: false; readonly message: string }
import type { RegistryDeps } from '@/types/registry'
import type { SessionIndex } from '@/types/session-index'
import type { ReadSessionStateParams, SessionScan, TranscriptTailStore } from '@/types/sessions'
import type { RunSearchParams, SearchResult } from '@/types/search'
import type { StageAllowIo, StageLauncherHandle, StageRegistry } from '@/types/stage'
import type { Dispatcher, RepoDispatchStatus } from '@/types/dispatch'
import type { ForceDispatch } from '@/types/tick'
import type { ReposListResponse } from '@/types/ipc'
import type { NeedsYouNotification, NotificationPrefs } from '@/types/settings'
import type { ReadWorktreeReportParams, WorktreesReport } from '@/types/reclaimer'

/** Omitting either field widens the force to every repository or every source. */
export type RefreshRequest = { readonly repoId?: RepoId; readonly source?: SourceKind } | undefined

/** The seam `'board.refresh'` composes through. */
export interface BoardRefreshDeps {
  readonly listRepositories: (deps: RegistryDeps) => Promise<ReposListResponse>
  readonly refresh: (request: RefreshRequest) => Promise<BoardSnapshot>
}

export interface IncidentChannelDeps {
  readonly listRepositories: (deps: RegistryDeps) => Promise<ReposListResponse>
  readonly log: Pick<IncidentLog, 'read'>
  readonly chooseSavePath: (defaultName: string) => Promise<string | null>
  readonly writeJson: (path: string, value: unknown) => Promise<FileResult<void>>
  readonly now: () => Date
}

export interface GateChannelDeps {
  readonly gatePreflight: (params: GatePreflightParams) => Promise<GatePreflightResponse>
  readonly gateAnswer: (params: GateAnswerParams) => Promise<GateAnswerResponse>
  readonly refresh: (request: RefreshRequest) => Promise<BoardSnapshot>
}

export interface HostingChannelDeps {
  readonly listRepositories: (deps: RegistryDeps) => Promise<ReposListResponse>
  readonly store: HostedStore
  readonly sessionIndex: SessionIndex
  /** Injectable so a test never touches a real `git` subprocess or filesystem. */
  readonly listSessionFiles: (cwd: string, deps?: FileListingDeps) => Promise<FileListingResult>
  readonly resolveStartTarget: (target: SessionStartTarget, mode: SessionStartMode, deps: ResolveStartTargetDeps) => Promise<ResolvedStartTarget>
  readonly targetDeps: Omit<ResolveStartTargetDeps, 'repositories'>
  readonly now: () => Date
  /** Best-effort cleanup for a worktree created ahead of a start that then failed — logged, never surfaced over the start result. */
  readonly removeCreatedWorktree: (path: string) => Promise<void>
}

/** The seam `'item.decide'` composes through. */
export interface ItemDecisionDeps {
  readonly listRepositories: (deps: RegistryDeps) => Promise<ReposListResponse>
  readonly applyItemDecision: (params: ApplyItemDecisionParams) => Promise<ItemDecisionResult>
  readonly sessions: () => readonly HostedSessionSnapshot[]
  readonly snapshot: () => BoardSnapshot
  readonly refresh: (request: RefreshRequest) => Promise<BoardSnapshot>
}

export interface TranscriptTailDeps {
  readonly openTail: TranscriptTailStore['openTail']
  readonly pollTail: TranscriptTailStore['pollTail']
  readonly closeTail: TranscriptTailStore['closeTail']
}

export interface SessionsScanDeps {
  readonly listRepositories: (deps: RegistryDeps) => Promise<ReposListResponse>
  readonly readSessionState: (params: ReadSessionStateParams) => Promise<SessionScan>
}

export interface SearchQueryDeps {
  readonly resolveSessionsScan: (registryDeps: RegistryDeps) => Promise<SessionScan>
  readonly runSearch: (params: RunSearchParams) => Promise<SearchResult>
}

export interface StageChannelDeps {
  readonly listRepositories: (deps: RegistryDeps) => Promise<ReposListResponse>
  readonly registry: StageRegistry
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
