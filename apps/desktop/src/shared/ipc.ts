import type { AssertEqual } from './assert-type'
import type { RepoId, RepositoryEntry } from './repos'
import type { WorktreesReclaimResult, WorktreesReport } from './reclaimer/types'
import type { SessionScan } from './sessions/types'
import type { TranscriptTailOpen, TranscriptTailPoll } from './sessions/transcript'
import type { SearchQuery, SearchResult } from './search/types'
import type { BoardSnapshot, SourceKind } from './board/types'
import type { ClaimApplyResponse, ClaimPreflightResponse, PlanGateChoice } from './claim/types'
import type { GateAnswerResponse, GateDecision, GatePreflightResponse } from './gate/types'
import type { LabelKey } from './labels/vocabulary'
import type { ItemActionResult, ItemDecisionResult, OperatorAction, OperatorDecision, UnblockRoute } from './actions/types'
import type { DispatchControlResult } from './dispatch/types'
import type { RuntimePreflight, RuntimeProbe } from './runtime/types'
import type { GhStatus } from './gh/types'
import type { BacklogResponse } from './backlog/types'
import type { StageAllowResult, StageResumeResult, StageRestartResult } from './stage/types'
import type {
  HostedSessionSnapshot,
  HostingCapacity,
  PermissionDecision,
  RestorableSession,
  SessionAttachResult,
  SessionCloseResult,
  SessionDefaults,
  SessionDismissResult,
  SessionEntriesDelta,
  SessionFilesResult,
  SessionInterruptResult,
  SessionInvokeResult,
  SessionKey,
  SessionMarkResult,
  SessionMarks,
  SessionPermissionAnswerResult,
  SessionRenameResult,
  SessionRestoreDiscardResult,
  SessionRestoreResult,
  SessionSendResult,
  SessionStartMode,
  SessionStartResult,
  SessionStartTarget,
  SessionTaskStopResult,
  WorktreeChoice,
} from './hosting/types'
import type { PlanAnswerResult, PlanDecision, QuestionAnswerResult, SessionControls, SetControlsResult } from './hosting/controls'
import type { ComposerAttachment } from './hosting/attachments'
import type { FolderEntry, SessionChanges } from './workspace/types'
import type { AppCommand } from './shell/commands'

export interface AppInfo {
  app: string
  electron: string
  node: string
  chromium: string
}

/** Every failure kind `readRegistry`/`writeRegistry` can report, shared by all three channels below. */
export type RegistryFailureKind = 'registry-malformed' | 'registry-unsupported-version' | 'registry-unreadable' | 'registry-unwritable'

export type ReposListResponse =
  | { readonly ok: true; readonly repositories: readonly RepositoryEntry[] }
  | { readonly ok: false; readonly kind: RegistryFailureKind; readonly message: string }

export type ReposAddResponse =
  | { readonly ok: true; readonly outcome: 'added'; readonly added: RepoId; readonly repositories: readonly RepositoryEntry[] }
  | { readonly ok: true; readonly outcome: 'cancelled' }
  | { readonly ok: true; readonly outcome: 'already-registered'; readonly existing: RepoId; readonly repositories: readonly RepositoryEntry[] }
  | { readonly ok: false; readonly kind: RegistryFailureKind; readonly message: string }

export type ReposRemoveResponse =
  | { readonly ok: true; readonly repositories: readonly RepositoryEntry[] }
  | { readonly ok: false; readonly kind: 'not-registered' | 'registry-unwritable'; readonly message: string }

export interface IpcMap {
  'app:info': {
    request: void
    response: AppInfo
  }
  'repos:list': {
    request: void
    response: ReposListResponse
  }
  'repos:add': {
    request: void
    response: ReposAddResponse
  }
  'repos:remove': {
    request: { id: RepoId }
    response: ReposRemoveResponse
  }
  'worktrees:report': {
    request: { id: RepoId }
    response: WorktreesReport
  }
  // The Worktrees tab's own write — `issue: null` reclaims every candidate.
  'worktrees:reclaim': {
    request: { id: RepoId; issue: number | null }
    response: WorktreesReclaimResult
  }
  'sessions:scan': {
    request: void
    response: SessionScan
  }
  'transcript:tail:open': {
    request: { sessionId: string; agentId: string | null }
    response: TranscriptTailOpen
  }
  'transcript:tail:poll': {
    request: { tailId: string }
    response: TranscriptTailPoll
  }
  'transcript:tail:close': {
    request: { tailId: string }
    response: void
  }
  /** Full-text search across every transcript in scope — the renderer sends the raw query string and an opaque scope, never a path or a parsed term list. */
  'search:query': {
    request: SearchQuery
    response: SearchResult
  }
  /** The board's initial paint — one invoke, no polling of its own; every later update arrives over the `board:update` event instead. */
  'board:snapshot': {
    request: void
    response: BoardSnapshot
  }
  /** `repoId`/`source` both optional — omitting either widens the force to every repository or every source. */
  'board:refresh': {
    request: { repoId?: RepoId; source?: SourceKind }
    response: BoardSnapshot
  }
  /** The claim dialog's read — resolves one issue's kind, labels, assignees, blockers, and the viewer's login, and classifies it, all server-side. */
  'claim:preflight': {
    request: { repoId: RepoId; number: number }
    response: ClaimPreflightResponse
  }
  /** The claim dialog's write. A fresh read that disagrees with `confirmedAssignees` refuses as `moved` rather than applying an unconfirmed take-over. */
  'claim:apply': {
    request: { repoId: RepoId; number: number; planGate: PlanGateChoice; confirmedAssignees: readonly string[] }
    response: ClaimApplyResponse
  }
  /** The board's single-label operator actions — pause/resume/retry/gate. `expectedStage` is used server-side only to refuse a stale click, never to widen what gets written. */
  'item:action': {
    request: { repoId: RepoId; kind: 'issue' | 'pull-request'; number: number; action: OperatorAction; expectedStage: LabelKey | null }
    response: ItemActionResult
  }
  /** The board's two operator decisions — unblock and revise. `skipComment`
   *  can only ever suppress the comment on a retry, never widen the write. */
  'item:decide': {
    request: { repoId: RepoId; number: number; decision: OperatorDecision; expectedStage: LabelKey | null; route: UnblockRoute | null; note: string | null; skipComment: boolean }
    response: ItemDecisionResult
  }
  /** Operator control over dispatch. `repoId` is required for `run`/`drain`/`pause`/`take-over` and must be omitted for `halt`, which sweeps every ready repository. `take-over` overwrites a `terminal` ownership record and then runs. */
  'dispatch:control': {
    request: { command: 'halt' } | { command: 'run' | 'drain' | 'pause' | 'take-over'; repoId: RepoId }
    response: DispatchControlResult
  }
  /** The runtime strip's cheap check — no repository context, no subprocess beyond `claude --version`, no network. There is no failure branch; every failure *is* a diagnosis. */
  'runtime:preflight': {
    request: void
    response: RuntimePreflight
  }
  /** One `query()` turn, against a registered repository or, when `repoId` is `null`, an app-owned scratch directory. `null` is explicit rather than optional. */
  'runtime:probe': {
    request: { repoId: RepoId | null }
    response: RuntimeProbe
  }
  /** The plan gate's own preflight read — resolves one issue's identity, labels, assignees, and body, classifies it, and reads this repository's ownership, all server-side. */
  'gate:preflight': {
    request: { repoId: RepoId; number: number }
    response: GatePreflightResponse
  }
  /** The plan gate's own write. `feedback` is required only when `decision` is `'request-changes'` and `skipComment` is `false`; `skipComment` can only ever suppress a write, never widen one. */
  'gate:answer': {
    request: { repoId: RepoId; number: number; decision: GateDecision; feedback: string | null; skipComment: boolean }
    response: GateAnswerResponse
  }
  /** Owns the full lifecycle of a hosted session in the main process — the renderer only sends intents and receives events. `target` resolves only against a folder main already holds (registry or recents) or a transcript's own cwd; the renderer never sends a path. */
  'session:start': {
    request: { target: SessionStartTarget; mode: SessionStartMode }
    response: SessionStartResult
  }
  /** Always accepted, never refused mid-turn; `text` may be empty only with at least one attachment. */
  'session:send': {
    request: { sessionKey: SessionKey; text: string; attachments?: readonly ComposerAttachment[] }
    response: SessionSendResult
  }
  'session:interrupt': {
    request: { sessionKey: SessionKey }
    response: SessionInterruptResult
  }
  /** Graceful: the input iterator ends, a bounded grace window, then
   *  `query.close()`. */
  'session:close': {
    request: { sessionKey: SessionKey }
    response: SessionCloseResult
  }
  /** The reconnect path after a renderer reload — handles are main-process-owned and survive it. `replay` is a bounded window, never the whole session. */
  'session:attach': {
    request: { sessionKey: SessionKey }
    response: SessionAttachResult
  }
  'session:list': {
    request: void
    response: readonly HostedSessionSnapshot[]
  }
  /** The permission dialog's own write. `message` is required (non-null) only when `decision` is `'deny'`, optional even then. */
  'session:permission:answer': {
    request: { sessionKey: SessionKey; permissionId: string; decision: PermissionDecision; message: string | null }
    response: SessionPermissionAnswerResult
  }
  /** The Pipeline strip's own write — runs `name` (already namespace-stripped) as `/<name> <args>` in the live session. `name`'s content is validated server-side, never here. */
  'session:invoke': {
    request: { sessionKey: SessionKey; name: string; args: string }
    response: SessionInvokeResult
  }
  /** Removes an ended handle from the rail — `still-open` for any other phase. `worktree` is required and never forces removal without the operator's explicit `'force'`. */
  'session:dismiss': {
    request: { sessionKey: SessionKey; worktree: WorktreeChoice }
    response: SessionDismissResult
  }
  /** The rail's own limit/open count — takes no payload. */
  'session:capacity': {
    request: void
    response: HostingCapacity
  }
  /** `limit` must be an integer from 1 to `SESSION_LIMIT_CEILING` — never closes a session, even when lowered below the open count. */
  'session:capacity:set': {
    request: { limit: number }
    response: HostingCapacity
  }
  /** The restore banner's own boot-time read — availability resolved through `listRepositories`. */
  'session:restore:list': {
    request: void
    response: { entries: readonly RestorableSession[] }
  }
  /** Resumes one restorable entry through the normal `start` path, so capacity and `already-open` still apply. */
  'session:restore': {
    request: { restoreId: string }
    response: SessionRestoreResult
  }
  /** `restoreId: null` discards every entry — idempotent either way. */
  'session:restore:discard': {
    request: { restoreId: string | null }
    response: SessionRestoreDiscardResult
  }
  /** The background-task panel's own Stop — `taskId` is scoped to this session's own `backgroundTasks`, never forwarded otherwise. */
  'session:task:stop': {
    request: { sessionKey: SessionKey; taskId: string }
    response: SessionTaskStopResult
  }
  /** The footer's gh status dot — no payload; never throws for a gh failure itself. */
  'gh:status': {
    request: void
    response: GhStatus
  }
  /** The Backlog screen's own read — open issues carrying no vocabulary label. */
  'backlog:list': {
    request: { repoId: RepoId }
    response: BacklogResponse
  }
  /** The Settings screen's own read of an operator's persisted session defaults. */
  'session:defaults': {
    request: void
    response: SessionDefaults
  }
  /** The Settings screen's own write; `model`/`permissionMode` must each name an allowlisted value. */
  'session:defaults:set': {
    request: SessionDefaults
    response: SessionDefaults
  }
  /** The rename dialog's own write; the title changes only after the on-disk rename lands. */
  'session:rename': {
    request: { sessionKey: SessionKey; title: string }
    response: SessionRenameResult
  }
  /** The controls bar's own write, one allowlisted field per SDK call. */
  'session:controls:set': {
    request: { sessionKey: SessionKey; permissionMode?: SessionControls['permissionMode']; model?: string; effort?: SessionControls['effort'] }
    response: SetControlsResult
  }
  /** The question card's own write — `answers` keyed by each question's own text. */
  'session:question:answer': {
    request: { sessionKey: SessionKey; permissionId: string; answers: Record<string, string> }
    response: QuestionAnswerResult
  }
  /** The plan card's own write. */
  'session:plan:answer': {
    request: { sessionKey: SessionKey; permissionId: string; decision: PlanDecision }
    response: PlanAnswerResult
  }
  /** The `@` suggestion list's own file source, resolved from the session's own cwd. */
  'session:files': {
    request: { sessionKey: SessionKey }
    response: SessionFilesResult
  }
  /** The folder picker's own read — ready registry repos first, then recents, deduped by path. */
  'folders:list': {
    request: void
    response: { folders: readonly FolderEntry[] }
  }
  /** The folder picker's own write — the native directory dialog. Records the chosen folder in recents. */
  'folders:choose': {
    request: void
    response: { outcome: 'chosen'; folder: FolderEntry } | { outcome: 'cancelled' }
  }
  /** The Changes tab's own read — a session's diff against its recorded base. */
  'session:changes': {
    request: { sessionKey: SessionKey }
    response: SessionChanges
  }
  /** The sidebar and History's own read of pin/archive marks. */
  'session:marks': {
    request: void
    response: SessionMarks
  }
  /** Pins or unpins a session, by its `claudeSessionId`. */
  'session:pin:set': {
    request: { sessionId: string; pinned: boolean }
    response: SessionMarkResult
  }
  /** Archives or unarchives a session, by its `claudeSessionId`. */
  'session:archive:set': {
    request: { sessionId: string; archived: boolean }
    response: SessionMarkResult
  }
  /** The denial dialog's own write — `rule` is re-validated main-side, the renderer's edit is never trusted. The repository root comes from the registry by `repoId`, never a renderer-named path. */
  'stage:allow': {
    request: { repoId: RepoId; denialId: string; rule: string }
    response: StageAllowResult
  }
  /** The denial row's own Dismiss — clears the item without touching the allowlist. */
  'stage:dismiss-denial': {
    request: { repoId: RepoId; denialId: string }
    response: void
  }
  /** `id` is an app-minted registry id, never a `claudeSessionId`. */
  'stage:resume': {
    request: { id: string }
    response: StageResumeResult
  }
  'stage:restart': {
    request: { id: string }
    response: StageRestartResult
  }
}

export const IPC_CHANNELS = [
  'app:info',
  'repos:list',
  'repos:add',
  'repos:remove',
  'worktrees:report',
  'worktrees:reclaim',
  'sessions:scan',
  'transcript:tail:open',
  'transcript:tail:poll',
  'transcript:tail:close',
  'search:query',
  'board:snapshot',
  'board:refresh',
  'claim:preflight',
  'claim:apply',
  'item:action',
  'item:decide',
  'dispatch:control',
  'runtime:preflight',
  'runtime:probe',
  'gate:preflight',
  'gate:answer',
  'session:start',
  'session:send',
  'session:interrupt',
  'session:close',
  'session:attach',
  'session:list',
  'session:permission:answer',
  'session:invoke',
  'session:dismiss',
  'session:capacity',
  'session:capacity:set',
  'session:restore:list',
  'session:restore',
  'session:restore:discard',
  'gh:status',
  'backlog:list',
  'session:defaults',
  'session:defaults:set',
  'session:rename',
  'session:controls:set',
  'session:question:answer',
  'session:plan:answer',
  'session:files',
  'folders:list',
  'folders:choose',
  'session:changes',
  'session:marks',
  'session:pin:set',
  'session:archive:set',
  'session:task:stop',
  'stage:allow',
  'stage:dismiss-denial',
  'stage:resume',
  'stage:restart',
] as const

export type IpcChannel = (typeof IPC_CHANNELS)[number]

// Fails to compile if IPC_CHANNELS and IpcMap's keys drift apart.
export const _channelsMatchIpcMap: AssertEqual<IpcChannel, keyof IpcMap> = true

/** The main → renderer push direction — a second `as const` list with its own `IpcEventMap` and `AssertEqual` pin. The listener receives the payload only, never the Electron event object, which would hand `sender` to a sandboxed renderer. */
export interface IpcEventMap {
  'board:update': BoardSnapshot
  /** This app's own typed snapshot, on every phase change — never a delta, since folding the phase machine into the SDK envelope would mix our vocabulary into a payload we promised to forward untouched. */
  'session:status': HostedSessionSnapshot
  /** The live projector's own delta — narrowed, renderer-safe values, never the opaque envelope the removed `session:event` once carried. */
  'session:entries': SessionEntriesDelta
  /** The app menu's own click, and a notification's own `click` — both run through the same action runner the keyboard map uses. */
  'app:command': AppCommand
}

export const IPC_EVENTS = ['board:update', 'session:status', 'session:entries', 'app:command'] as const

export type IpcEvent = (typeof IPC_EVENTS)[number]

export const _eventsMatchIpcEventMap: AssertEqual<IpcEvent, keyof IpcEventMap> = true

/** The bridge's own name derivation, moved out of the preload so the renderer can resolve `window.port[bridgeMethodName(channel)]` without a second, copied implementation. */
type CamelCase<S extends string> = S extends `${infer Head}:${infer Rest}` ? `${Head}${Capitalize<CamelCase<Rest>>}` : S

export type BridgeMethod<C extends string> = CamelCase<C>
export type BridgeListener<E extends string> = `on${Capitalize<CamelCase<E>>}`

export function bridgeMethodName<C extends string>(channel: C): BridgeMethod<C> {
  return channel.replace(/:([a-z])/g, (_match, letter: string) => letter.toUpperCase()) as BridgeMethod<C>
}

export function bridgeListenerName<E extends string>(event: E): BridgeListener<E> {
  const camel = bridgeMethodName(event)
  return `on${camel.charAt(0).toUpperCase()}${camel.slice(1)}` as BridgeListener<E>
}
