import type { GatePreflightParams, GateAnswerParams, ApplyItemDecisionParams, ItemDecisionResult, ApplyItemActionParams, ItemActionResult } from '@/types/actions'
import type { GatePreflightResponse, GateAnswerResponse } from '@/types/gate'
import type { IpcMap } from '@/types/ipc'
import type { BoardSnapshot } from '@/types/board'
import type { HostedSessionSnapshot, HostedStore, SessionStartTarget, SessionStartMode } from '@/types/hosting'
import type { ResolveStartTargetDeps, ReleaseBranchOutcome, RemoveSessionWorktreeOutcome, ResolvedStartTarget } from '@/types/workspace'
import type { DirEntry, FileResult, GitLinesResult, RunCommandOptions } from '@/types/platform'

/** `main/hosting/files.ts`'s own injectable seam, inlined here since a `types/` file may not import a
 *  value from `main/` — this is the whole real shape, not an approximation. */
type FileListingDeps = {
  readonly gitLines: (args: readonly string[], options: Omit<RunCommandOptions, 'whichEnv' | 'platform'>) => Promise<GitLinesResult>
  readonly listDirectory: (path: string) => Promise<FileResult<readonly DirEntry[]>>
}
type FileListingResult = { readonly ok: true; readonly files: readonly string[]; readonly truncated: boolean } | { readonly ok: false; readonly message: string }
import type { RegistryDeps } from '@/types/registry'
import type { SessionIndex } from '@/types/session-index'
import type { SessionScan } from '@/types/sessions'
import type { RunSearchParams, SearchResult } from '@/types/search'
import type { StageLauncherHandle, StageRegistry } from '@/types/stage'
import type { Dispatcher, RepoDispatchStatus } from '@/types/dispatch'
import type { ForceDispatch } from '@/types/tick'
import type { IpcChannel, ReposListResponse } from '@/types/ipc'
import type { AssertEqual } from '@/types/assert-type'
import type { NotificationPrefs } from '@/types/settings'

export interface GateChannelDeps {
  readonly gatePreflight: (params: GatePreflightParams) => Promise<GatePreflightResponse>
  readonly gateAnswer: (params: GateAnswerParams) => Promise<GateAnswerResponse>
  readonly refresh: (request: IpcMap['board:refresh']['request']) => Promise<BoardSnapshot>
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

/** The seam `'item:decide'` composes through. */
export interface ItemDecisionDeps {
  readonly listRepositories: (deps: RegistryDeps) => Promise<ReposListResponse>
  readonly applyItemDecision: (params: ApplyItemDecisionParams) => Promise<ItemDecisionResult>
  readonly sessions: () => readonly HostedSessionSnapshot[]
  readonly snapshot: () => BoardSnapshot
  readonly refresh: (request: IpcMap['board:refresh']['request']) => Promise<BoardSnapshot>
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
  readonly readJson: <T>(path: string) => Promise<FileResult<T>>
  readonly writeJsonAtomic: (path: string, value: unknown) => Promise<FileResult<void>>
}

/** The seam `'held:force-dispatch'` composes through. `dispatcherStatus` reads the same `RepoDispatchStatus.owner` the board already renders, never a second ownership read. */
export interface HeldChannelDeps {
  readonly snapshot: () => BoardSnapshot
  readonly dispatcherStatus: () => readonly RepoDispatchStatus[]
  readonly forceDispatch: ForceDispatch
  /** The watcher's own republish — picks up the override immediately, never waiting for the next poll. */
  readonly republish: () => void
}

/** The seam `'notify:needs-you'` composes through — `show` owns the focus rule and the Electron notification. */
export interface NotifyChannelDeps {
  readonly show: (notification: IpcMap['notify:needs-you']['request']) => void
}

/** The seam `'notify:prefs'`/`'notify:prefs:set'` compose through — the hosted store's persisted preferences. */
export interface NotifyPrefsDeps {
  readonly prefs: () => Promise<NotificationPrefs>
  readonly setPrefs: (next: NotificationPrefs) => Promise<NotificationPrefs>
}

// The read/write partition over IpcChannel — hand-maintained, never derived from IPC_CHANNELS.
export const QUERY_CHANNELS = [
  'app:info',
  'repos:list',
  'worktrees:report',
  'sessions:scan',
  'search:query',
  'board:snapshot',
  'claim:preflight',
  'runtime:preflight',
  'gate:preflight',
  'session:list',
  'session:index',
  'session:capacity',
  'session:restore:list',
  'gh:status',
  'session:defaults',
  'backlog:list',
  'session:files',
  'folders:list',
  'session:changes',
  'session:marks',
  'notify:prefs',
  'storage:report',
  'usage:summary',
] as const

export type QueryChannel = (typeof QUERY_CHANNELS)[number]

// Every other channel, including the ones that move state in the main process.
export const MUTATION_CHANNELS = [
  'repos:add',
  'repos:remove',
  'transcript:tail:open',
  'transcript:tail:poll',
  'transcript:tail:close',
  'board:refresh',
  'worktrees:reclaim',
  'claim:apply',
  'item:action',
  'item:decide',
  'dispatch:control',
  'runtime:probe',
  'gate:answer',
  'session:start',
  'session:send',
  'session:interrupt',
  'session:close',
  'session:attach',
  'session:permission:answer',
  'session:invoke',
  'session:dismiss',
  'session:capacity:set',
  'session:restore',
  'session:restore:discard',
  'session:defaults:set',
  'session:rename',
  'session:controls:set',
  'session:question:answer',
  'session:plan:answer',
  'session:task:stop',
  'folders:choose',
  'session:pin:set',
  'session:archive:set',
  'stage:allow',
  'stage:dismiss-denial',
  'stage:resume',
  'stage:restart',
  'held:force-dispatch',
  'notify:needs-you',
  'notify:prefs:set',
] as const

export type MutationChannel = (typeof MUTATION_CHANNELS)[number]

// Fails to compile when a channel is unclassified, misclassified into both
// lists, or either list drifts from IpcMap's own keys.
export const _queryAndMutationCoverIpcChannel: AssertEqual<QueryChannel | MutationChannel, IpcChannel> = true
export const _queryAndMutationNeverOverlap: AssertEqual<QueryChannel & MutationChannel, never> = true
