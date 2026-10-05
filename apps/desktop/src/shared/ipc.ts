import type { AssertEqual } from './assert-type'
import type { RepoId, RepositoryEntry } from './repos'
import type { WorktreesReport } from './reclaimer/types'
import type { SessionScan } from './sessions/types'
import type { TranscriptTailOpen, TranscriptTailPoll } from './sessions/transcript'
import type { SearchQuery, SearchResult } from './search/types'
import type { BoardSnapshot, SourceKind } from './board/types'
import type { ClaimApplyResponse, ClaimPreflightResponse, PlanGateChoice } from './claim/types'
import type { GateAnswerResponse, GateClaimResponse, GateDecision, GatePreflightResponse } from './gate/types'
import type { LabelKey } from './labels/vocabulary'
import type { ItemActionResult, ItemDecisionResult, OperatorAction, OperatorDecision, UnblockRoute } from './actions/types'
import type { DispatchClaimSetResult, DispatchControlResult } from './dispatch/types'
import type { RuntimePreflight, RuntimeProbe } from './runtime/types'
import type { ClaimRead } from './writes/types'
import type { RelayCopyResponse } from './relay/types'
import type { GhStatus } from './gh/types'
import type { BacklogResponse } from './backlog/types'
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
  SessionInterruptResult,
  SessionInvokeResult,
  SessionKey,
  SessionPermissionAnswerResult,
  SessionRenameResult,
  SessionRestoreDiscardResult,
  SessionRestoreResult,
  SessionSendResult,
  SessionStartMode,
  SessionStartResult,
} from './hosting/types'

export interface AppInfo {
  app: string
  electron: string
  node: string
  chromium: string
}

/** Every failure kind `readRegistry`/`writeRegistry` can report, shared by
 *  all three channels below so a filesystem-level registry problem always
 *  carries the same three variants. */
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
  /** Full-text search across every transcript in scope (#87) — the renderer
   *  sends the raw query string and an opaque scope, never a path or a
   *  parsed term list. */
  'search:query': {
    request: SearchQuery
    response: SearchResult
  }
  /** The board's initial paint — one invoke, no polling of its own; every
   *  later update arrives over the `board:update` event instead (#80). */
  'board:snapshot': {
    request: void
    response: BoardSnapshot
  }
  /** `repoId`/`source` both optional — omitting either widens the force to
   *  every repository or every source; the watcher's own in-flight guard is
   *  what stops a held button from stacking round trips. */
  'board:refresh': {
    request: { repoId?: RepoId; source?: SourceKind }
    response: BoardSnapshot
  }
  /** The claim dialog's read (#93) — resolves one issue's kind, labels,
   *  assignees, blockers, and the viewer's own login, and classifies it, all
   *  server-side; the renderer names an intent, never a precondition. */
  'claim:preflight': {
    request: { repoId: RepoId; number: number }
    response: ClaimPreflightResponse
  }
  /** The claim dialog's write. `confirmedAssignees` is the exact assignee
   *  list the review step displayed — a fresh read that disagrees with it
   *  refuses as `moved` rather than applying a take-over the operator never
   *  actually confirmed. */
  'claim:apply': {
    request: { repoId: RepoId; number: number; planGate: PlanGateChoice; confirmedAssignees: readonly string[] }
    response: ClaimApplyResponse
  }
  /** The board's single-label operator actions (#94) — pause/resume/retry/
   *  gate. The renderer sends an intent, never a label set: `expectedStage`
   *  is the row's own `stageLabel?.key` at click time, used server-side
   *  only to refuse a stale click, never to widen what gets written. */
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
  /** Operator control over dispatch (#110, #314) — run/drain/pause one
   *  repository, or halt everything. `repoId` is required for `run`/`drain`/
   *  `pause` (a registered repository, any status) and must be omitted for
   *  `halt`, which sweeps every ready repository this app knows about. */
  'dispatch:control': {
    request: { command: 'halt' } | { command: 'run' | 'drain' | 'pause'; repoId: RepoId }
    response: DispatchControlResult
  }
  /** #265: takes or releases the `dispatch` claim scope for one repository —
   *  `held` is the target state the operator's own button named, the same
   *  never-a-toggle rule `gate:claim:set` already follows. Operator action
   *  only; nothing machine-observed ever calls this. */
  'dispatch:claim:set': {
    request: { repoId: RepoId; held: boolean }
    response: DispatchClaimSetResult
  }
  /** The runtime strip's cheap check (#97) — no repository context, no
   *  subprocess beyond `claude --version`, no network. Safe on every app
   *  start; there is no failure branch, because every failure *is* a
   *  diagnosis. */
  'runtime:preflight': {
    request: void
    response: RuntimePreflight
  }
  /** One `query()` turn against a registered, `ready` repository — the
   *  renderer names an intent (`repoId`), never a path or a `cwd`. */
  'runtime:probe': {
    request: { repoId: RepoId }
    response: RuntimeProbe
  }
  /** The plan gate's own preflight read (#92) — resolves one issue's
   *  identity, labels, assignees, and body (split into ticket/plan
   *  markdown), classifies it, and reads the plan-gate claim, all
   *  server-side; the renderer names an intent, never a precondition. */
  'gate:preflight': {
    request: { repoId: RepoId; number: number }
    response: GatePreflightResponse
  }
  /** The Claim step's own re-read — called fresh every time the dialog opens
   *  at that step, never reused from the preflight's own (potentially
   *  stale) claim reading. */
  'gate:claim:read': {
    request: { repoId: RepoId }
    response: ClaimRead
  }
  /** `held` is the target state the operator's own button named — `true` to
   *  take the claim, `false` to release it — never a toggle this channel
   *  infers from the current state. */
  'gate:claim:set': {
    request: { repoId: RepoId; held: boolean }
    response: GateClaimResponse
  }
  /** The plan gate's own write. `feedback` is required (non-empty) only when
   *  `decision` is `'request-changes'` and `skipComment` is `false`;
   *  `skipComment` is `true` only on a retry after a comment already landed
   *  and the label swap alone failed — it can only ever suppress a write,
   *  never widen one. */
  'gate:answer': {
    request: { repoId: RepoId; number: number; decision: GateDecision; feedback: string | null; skipComment: boolean }
    response: GateAnswerResponse
  }
  /** The relay loop's own copy button (#107) — the renderer sends the
   *  already-composed reply text; `main/relay/clipboard.ts`'s
   *  `copyRelayReply` validates it (non-empty string, under
   *  `MAX_REPLY_CHARS`) before electron's clipboard is ever touched. Nothing
   *  is sent anywhere — the operator still pastes it into the session that
   *  dispatched the agent. */
  'relay:copy': {
    request: { text: string }
    response: RelayCopyResponse
  }
  /** #98: owns the full lifecycle of a hosted session in the main process
   *  — the renderer only sends intents and receives events. `mode.kind` one
   *  of `fresh | resume | resume-at | fork`; `repoId` must name a
   *  currently registered, `ready` repository. */
  'session:start': {
    request: { repoId: RepoId; mode: SessionStartMode }
    response: SessionStartResult
  }
  /** Always accepted, never refused mid-turn — the SDK owns the queue. */
  'session:send': {
    request: { sessionKey: SessionKey; text: string }
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
  /** The reconnect path after a renderer reload — handles are
   *  main-process-owned and survive it. `replay` is a bounded window, never
   *  the whole session. */
  'session:attach': {
    request: { sessionKey: SessionKey }
    response: SessionAttachResult
  }
  'session:list': {
    request: void
    response: readonly HostedSessionSnapshot[]
  }
  /** #99: the permission dialog's own write. `message` is required
   *  (non-null) only when `decision` is `'deny'`, optional even then. */
  'session:permission:answer': {
    request: { sessionKey: SessionKey; permissionId: string; decision: PermissionDecision; message: string | null }
    response: SessionPermissionAnswerResult
  }
  /** #101: the Pipeline strip's own write — runs `name` (already
   *  namespace-stripped, e.g. `'pipeline'`) as `/<name> <args>` in the live
   *  session. `name`'s content is validated server-side, never here — see
   *  `channels/hosting.ts`'s own doc comment. */
  'session:invoke': {
    request: { sessionKey: SessionKey; name: string; args: string }
    response: SessionInvokeResult
  }
  /** #103: removes an ended handle from the rail — `still-open` for any
   *  other phase. */
  'session:dismiss': {
    request: { sessionKey: SessionKey }
    response: SessionDismissResult
  }
  /** #103: the rail's own limit/open count — takes no payload. */
  'session:capacity': {
    request: void
    response: HostingCapacity
  }
  /** #103: `limit` must be an integer from 1 to `SESSION_LIMIT_CEILING` —
   *  never closes a session, even when lowered below the open count. */
  'session:capacity:set': {
    request: { limit: number }
    response: HostingCapacity
  }
  /** #103: the restore banner's own boot-time read — availability resolved
   *  through `listRepositories`. */
  'session:restore:list': {
    request: void
    response: { entries: readonly RestorableSession[] }
  }
  /** #103: resumes one restorable entry through the normal `start` path, so
   *  capacity and `already-open` still apply. */
  'session:restore': {
    request: { restoreId: string }
    response: SessionRestoreResult
  }
  /** #103: `restoreId: null` discards every entry — idempotent either way. */
  'session:restore:discard': {
    request: { restoreId: string | null }
    response: SessionRestoreDiscardResult
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
}

export const IPC_CHANNELS = [
  'app:info',
  'repos:list',
  'repos:add',
  'repos:remove',
  'worktrees:report',
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
  'dispatch:claim:set',
  'runtime:preflight',
  'runtime:probe',
  'gate:preflight',
  'gate:claim:read',
  'gate:claim:set',
  'gate:answer',
  'relay:copy',
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
] as const

export type IpcChannel = (typeof IPC_CHANNELS)[number]

// Fails to compile if IPC_CHANNELS and IpcMap's keys drift apart.
export const _channelsMatchIpcMap: AssertEqual<IpcChannel, keyof IpcMap> = true

/**
 * The main → renderer push direction — a second `as const` list with its own
 * `IpcEventMap` and its own `AssertEqual` pin, beside `IPC_CHANNELS` above,
 * exactly the compile-time contract that list already carries: an event
 * added to one and not the other fails `pnpm typecheck` (#80). The listener
 * receives the payload only, never the Electron event object, which would
 * hand `sender` to a sandboxed renderer.
 */
export interface IpcEventMap {
  'board:update': BoardSnapshot
  /** This app's own typed snapshot, on every phase change — never a delta,
   *  since folding the phase machine into the SDK envelope would put our
   *  vocabulary inside a payload we promised to forward untouched. */
  'session:status': HostedSessionSnapshot
  /** #219: the live projector's own delta — narrowed, renderer-safe
   *  `TranscriptEntry`/`PartialUpdate` values, never the opaque envelope
   *  the removed `session:event` once carried. */
  'session:entries': SessionEntriesDelta
}

export const IPC_EVENTS = ['board:update', 'session:status', 'session:entries'] as const

export type IpcEvent = (typeof IPC_EVENTS)[number]

export const _eventsMatchIpcEventMap: AssertEqual<IpcEvent, keyof IpcEventMap> = true

/**
 * The bridge's own name derivation (#316) — moved out of the preload so
 * `renderer/src/data/invoke.ts` can resolve `window.port[bridgeMethodName(channel)]`
 * without a second, copied implementation. `preload/index.ts` imports both
 * functions below rather than redeclaring them, so there is exactly one
 * `channel:name` → `camelCase` mapping to pin.
 */
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
