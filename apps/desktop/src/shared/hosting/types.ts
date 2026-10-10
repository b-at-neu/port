// Renderer-safe contract for a hosted session. No import here may reach a Node builtin — only `main/hosting/` spawns a `claude` child or holds a `Query`. `message: unknown` on the event envelope is deliberate: narrowing it is the renderer's own job, never a second guess at the SDK's union here.
import type { RepoId } from '../repos'
import type { RuntimeDiagnosis } from '../runtime/types'
import type { EntryPatch, TranscriptEntry } from '../sessions/transcript'
import type { SessionWorkspace } from '../workspace/types'
import type { PendingInteraction, SessionControls, SessionModels } from './controls'
import type { SessionUsage } from './usage'

declare const sessionKeyBrand: unique symbol

/** App-local (`hosted-<n>`) and never persisted, so a stale key from a previous run can never name a live handle. Distinct from `claudeSessionId`: every IPC call names a session by this key. */
export type SessionKey = string & { readonly [sessionKeyBrand]: true }

/** Every phase a hosted session's handle can report, driven entirely by what the stream itself says — never a guess. */
export type SessionPhase = 'starting' | 'ready' | 'streaming' | 'interrupting' | 'closing' | 'ended'

/** The four start modes: `claudeSessionId` is adopted only from the SDK's own `init` message, so the renderer never handles an id changing under it. */
export type SessionStartMode =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'resume'; readonly sessionId: string }
  | { readonly kind: 'resume-at'; readonly sessionId: string; readonly messageUuid: string; readonly resumeDropsTurn: string | null }
  | { readonly kind: 'fork'; readonly sessionId: string }

/** Lineage as reported on the snapshot — `forked` carries `atMessageUuid` (`null` when the fork branched from the tip) so a continuation and a branch are distinguishable without inspecting `SessionStartMode`. */
export type SessionOrigin =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'resumed'; readonly from: string }
  | { readonly kind: 'forked'; readonly from: string; readonly atMessageUuid: string | null }

/** Why a hosted session ended. `resume-rejected` is the CLI's deterministic refusal of a fork point — never retried, only rewound. Unrecognised text is `stream-error`, carried verbatim, never a guessed reason. */
export type SessionEndReason = 'completed' | 'closed' | 'exit-nonzero' | 'signal' | 'process-error' | 'stream-error' | 'resume-rejected'

/** `diagnosis` is `null` for the reasons that are not failures (`completed`, `closed`) and for `resume-rejected`, a deterministic refusal rather than a diagnosable failure. */
export interface SessionEnd {
  readonly reason: SessionEndReason
  readonly exitCode: number | null
  readonly signal: string | null
  readonly message: string | null
  readonly diagnosis: RuntimeDiagnosis | null
}

/** The full state pushed on every phase change, never a delta — snapshots are small and a delta invites drift. `queuedAfterInterrupt` is `null` when the CLI returned no receipt, reported as unknown, never zero. `pendingPermissions` is sorted oldest first and rides the snapshot rather than a second event stream, since a reload must never drop a prompt the SDK gives no park deadline. */
export interface HostedSessionSnapshot {
  readonly sessionKey: SessionKey
  readonly claudeSessionId: string | null
  readonly repoId: RepoId | null
  /** This session's resolved folder, worktree (if any), and diff base — carried on the snapshot rather than a second lookup. */
  readonly workspace: SessionWorkspace
  readonly phase: SessionPhase
  readonly origin: SessionOrigin
  readonly startedAt: string
  readonly queuedAfterInterrupt: number | null
  readonly end: SessionEnd | null
  readonly titled: boolean | null
  readonly pendingPermissions: readonly PendingPermission[]
  /** The Pipeline strip's own state — rides this snapshot rather than a second event stream. */
  readonly capabilities: SessionCapabilities
  /** The session's display title — set once and never changed after it goes non-null, so a label never shifts under the operator. */
  readonly title: string | null
  /** The newest reading off a `rate_limit_event` message — `null` until the first one arrives, never synthesized. */
  readonly rateLimit: SessionRateLimit | null
  /** This handle's own live controls tracker — every real handle sets it before the first snapshot is pushed. */
  readonly controls: SessionControls
  /** The model picker's own read-back — `pending` before the first read settles. */
  readonly models: SessionModels
  /** The newest cost/token/context reading off this process's own messages — `null` until the first usable one arrives. */
  readonly usage: SessionUsage | null
}

/** Pin and archive marks, keyed by `claudeSessionId` — app-local, persisted in `hosting.json`. */
export interface SessionMarks {
  readonly pinned: readonly string[]
  readonly archived: readonly string[]
}

/** `'session:pin:set'`/`'session:archive:set'`'s response — an empty or over-long id is a value, shown as a toast. */
export type SessionMarkResult = { readonly ok: true; readonly marks: SessionMarks } | { readonly ok: false; readonly kind: 'invalid-session-id' }

/** `session:event`'s payload — the SDK message crosses the boundary opaque; this app never narrows, interprets or executes it. `receivedAt` is this process's own clock, never the SDK's. */
export interface SessionEventEnvelope {
  readonly sessionKey: SessionKey
  readonly seq: number
  readonly receivedAt: string
  readonly message: unknown
}

/** A `session:start` target — a registered/recent folder by its `FolderId`, or the cwd of a named transcript. `worktree: true` on a folder target creates a session worktree before starting. */
export type SessionStartTarget = { readonly kind: 'folder'; readonly folderId: string; readonly worktree: boolean } | { readonly kind: 'transcript' }

/** `'keep'`/`'remove'`/`'force'` — a worktree session's dismiss choice. Never forces without the caller's explicit `'force'`. */
export type WorktreeChoice = 'keep' | 'remove' | 'force'

/** `'session:start'`'s response — `at-capacity` names the limit rather than a bare refusal; `runtime` carries the existing `RuntimeDiagnosis`/`detail`, never a new error vocabulary. The four workspace-resolution kinds are the operator-reachable half of `main/workspace/target.ts`'s own contract — a malformed target throws instead. */
export type SessionStartResult =
  | { readonly ok: true; readonly snapshot: HostedSessionSnapshot }
  | { readonly ok: false; readonly kind: 'at-capacity'; readonly limit: number }
  | { readonly ok: false; readonly kind: 'runtime'; readonly diagnosis: RuntimeDiagnosis; readonly detail: string | null }
  /** A `resume`/`resume-at` whose `sessionId` already names a live handle — fails closed, since two `claude` processes appending to one transcript is unrecoverable. */
  | { readonly ok: false; readonly kind: 'already-open'; readonly sessionKey: SessionKey }
  /** The target folder no longer exists — `path` is `null` for a transcript target whose session carries no `cwd`. */
  | { readonly ok: false; readonly kind: 'folder-missing'; readonly path: string | null }
  /** A non-worktree start refused because a live, non-worktree session is already open in this folder. */
  | { readonly ok: false; readonly kind: 'folder-busy'; readonly sessionKey: SessionKey }
  /** `worktree: true` against a folder that is not a git repository. */
  | { readonly ok: false; readonly kind: 'not-git' }
  /** `worktree: true` whose `git worktree add` failed. */
  | { readonly ok: false; readonly kind: 'worktree-failed'; readonly message: string }

/** `'session:send'`'s response — always `queued` rather than refusing mid-turn, since the SDK owns the queue. `blocked-command` is `/port:pipeline` (or bare `pipeline`, when this session reports no unqualified command of its own) sent by hand — an operator action, not a bug, so it is a typed value rather than a thrown refusal. */
export type SessionSendResult =
  | { readonly ok: true; readonly uuid: string; readonly queued: boolean }
  | { readonly ok: false; readonly kind: 'unknown-session' }
  | { readonly ok: false; readonly kind: 'blocked-command'; readonly name: string }

/** `'session:interrupt'`'s response — `queuedAfterInterrupt` is `null` exactly when the CLI's receipt carried none, never coerced to `0`. */
export type SessionInterruptResult = { readonly ok: true; readonly queuedAfterInterrupt: number | null } | { readonly ok: false; readonly kind: 'unknown-session' }

export type SessionCloseResult = { readonly ok: true } | { readonly ok: false; readonly kind: 'unknown-session' }

/** `'session:attach'`'s response — the reconnect path after a renderer reload; handles are main-process-owned and survive it. `replay` is a bounded window, never the whole session; `droppedBefore` tells a consumer to fall back to the transcript reader. `entries`/`firstIndex` are the projector's own bounded ring, `partial` the live streaming block's current state, `revision` the projector's monotonic counter — a gap against a later push is the renderer's re-attach signal. */
export type SessionAttachResult =
  | {
      readonly ok: true
      readonly snapshot: HostedSessionSnapshot
      readonly replay: readonly SessionEventEnvelope[]
      readonly droppedBefore: number
      readonly entries: readonly TranscriptEntry[]
      readonly firstIndex: number
      readonly partial: LiveBlock | null
      readonly pendingSends: readonly string[]
      readonly revision: number
    }
  | { readonly ok: false; readonly kind: 'unknown-session' }

/** A streaming text/thinking block's own kind — never a third value, since a tool call's input JSON is never streamed. */
export type LiveBlockKind = 'text' | 'thinking'

/** One streaming block's accumulated state. `blockId` is `<messageId>:<contentBlockIndex>`, never a tool call's own id. `omittedChars` is best-effort during the stream; the completed entry holds the exact count. */
export interface LiveBlock {
  readonly blockId: string
  readonly kind: LiveBlockKind
  readonly text: string
  readonly omittedChars: number
}

/** `session:entries`' own `partial` field — never the whole accumulated block. `append` opens or grows a block; `clear` fires on a stopped block's matching `assistant` message, or any `result`. */
export type PartialUpdate = { readonly op: 'append'; readonly blockId: string; readonly kind: LiveBlockKind; readonly text: string } | { readonly op: 'clear' }

/** `'session:entries'`'s push payload — the live projection's own delta, in the same `appended`/`patched` shape a transcript reader already uses, so the renderer applies both through one code path. `revision` is monotonic; a gap means re-attach. */
export interface SessionEntriesDelta {
  readonly sessionKey: SessionKey
  readonly revision: number
  readonly appended: readonly TranscriptEntry[]
  readonly patched: readonly EntryPatch[]
  readonly partial: PartialUpdate | null
  readonly pendingSends: readonly string[] | null
}

/** The three decisions the operator can send back for a pending permission request. `allow-session` is offered only when `sessionGrant` is non-null. */
export const PERMISSION_DECISIONS = ['allow-once', 'allow-session', 'deny'] as const

export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number]

/** What "allow for this session" would grant, narrowed and renderer-safe — never the SDK's own `PermissionUpdate`. One line of dialog copy per kind. */
export type SessionGrantItem =
  | { readonly kind: 'rule'; readonly toolName: string; readonly ruleContent: string | null }
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'accept-edits' }

/** One pending `canUseTool` call, as the renderer sees it — `permissionId` is app-minted, never the SDK's own id. `input` is verbatim and untrusted: rendered as text only. `sessionGrant` is `null` when the SDK offered nothing worth a session-wide grant. */
export interface PendingPermission {
  readonly permissionId: string
  readonly toolName: string
  readonly input: Readonly<Record<string, unknown>>
  readonly title: string | null
  readonly displayName: string | null
  readonly description: string | null
  readonly decisionReason: string | null
  readonly blockedPath: string | null
  readonly agentId: string | null
  readonly requestedAt: string
  readonly sessionGrant: readonly SessionGrantItem[] | null
  /** Non-`null` for an `AskUserQuestion`/`ExitPlanMode` call — the Session
   *  screen renders its own card for these instead of the generic dialog. */
  readonly interaction: PendingInteraction | null
}

/** `'session:permission:answer'`'s response: ordinary races and `no-session-grant`/`interaction-prompt` refusals are reported as values, never thrown. */
export type SessionPermissionAnswerResult = { readonly ok: true } | { readonly ok: false; readonly kind: 'unknown-session' | 'unknown-permission' | 'no-session-grant' | 'interaction-prompt' }

/** Which plugin path a session asked for — the repository's own copy (self-hosting) or the operator's installed one. Resolved once before spawn, carried on the snapshot so the operator sees it even before `init` confirms what loaded. */
export type PluginRequest = { readonly source: 'repository'; readonly path: string } | { readonly source: 'installed' }

/** What actually loaded, read back from the SDK rather than assumed. `unconfirmed` is the state before any `init` has arrived. */
export type PluginLoad =
  | { readonly kind: 'unconfirmed' }
  | { readonly kind: 'loaded'; readonly path: string; readonly version: string | null }
  | { readonly kind: 'missing' }
  | { readonly kind: 'shadowed'; readonly path: string; readonly version: string | null }
  | { readonly kind: 'duplicate'; readonly paths: readonly string[] }

/** Whether the loaded plugin's skills/agents match what the plugin directory declares — `unchecked` when the directory could not be read, never reported as `complete`. */
export type ComponentCheck =
  | { readonly kind: 'unchecked'; readonly reason: 'no-plugin-path' | 'unreadable' }
  | { readonly kind: 'complete' }
  | { readonly kind: 'incomplete'; readonly missingSkills: readonly string[]; readonly missingAgents: readonly string[] }

/** One `port:` slash command, renderer-safe — `description` goes through `sanitize` before it reaches this shape. */
export interface CommandSummary {
  readonly name: string
  readonly description: string
  readonly argumentHint: string
}

/** One slash command or skill this session reports, unfiltered by the `port:` prefix `CommandSummary` narrows to. */
export interface SlashCommandSummary {
  readonly name: string
  readonly description: string
  readonly argumentHint: string
}

/** One `port:` agent, renderer-safe — `model` is `null` when the agent's frontmatter names none. */
export interface AgentSummary {
  readonly name: string
  readonly description: string
  readonly model: string | null
}

/** The Pipeline strip's own state — `pending` before the capability read settles, `unavailable` on timeout or rejection, `ready` carrying the plugin load, component check, and filtered command/agent lists. */
export type SessionCapabilities =
  | { readonly kind: 'pending'; readonly request: PluginRequest }
  | { readonly kind: 'unavailable'; readonly request: PluginRequest; readonly message: string }
  | {
      readonly kind: 'ready'
      readonly request: PluginRequest
      readonly commands: readonly CommandSummary[]
      readonly agents: readonly AgentSummary[]
      readonly plugin: PluginLoad
      readonly components: ComponentCheck
      /** The composer's own `/` autocomplete source, sorted, pipeline already dropped. */
      readonly slashCommands: readonly SlashCommandSummary[]
    }

/** `'session:invoke'`'s response — a typed refusal for a name that fails the SDK's canonical-name rules or isn't in this session's current command list. */
export type SessionInvokeResult =
  | { readonly ok: true; readonly uuid: string; readonly queued: boolean }
  | { readonly ok: false; readonly kind: 'unknown-session' }
  | { readonly ok: false; readonly kind: 'invalid-command'; readonly reason: string }
  | { readonly ok: false; readonly kind: 'unknown-command'; readonly name: string }

/** A `rate_limit_event` narrowed structurally — `utilization` is deliberately not read, since its unit is undocumented and a wrong-unit percentage is misinformation. `observedAt` is this process's own clock. */
export interface SessionRateLimit {
  readonly status: 'allowed' | 'warning' | 'rejected'
  readonly window: 'five-hour' | 'weekly' | 'weekly-opus' | 'weekly-sonnet' | 'overage' | null
  readonly resetsAt: string | null
  readonly observedAt: string
}

/** `'session:capacity'`/`'session:capacity:set'`'s own shape — `ceiling` never changes, `limit` is the operator's own setting, persisted. */
export interface HostingCapacity {
  readonly limit: number
  readonly ceiling: number
}

/** One entry offered by the restore banner at boot — app-minted `restoreId`, never the persisted `claudeSessionId` itself, so the renderer can never send that id back verbatim. */
export interface RestorableSession {
  readonly restoreId: string
  readonly repoId: RepoId | null
  /** The persisted `cwd`, `null` for an older entry with none — the registry path backs its restore instead. */
  readonly folder: string | null
  readonly title: string | null
  readonly origin: { readonly kind: 'resumed'; readonly from: string }
  readonly startedAt: string
  readonly availability: { readonly ok: true } | { readonly ok: false; readonly reason: string }
}

/** `'session:dismiss'`'s response — an ended handle's row leaving the rail. `worktree-dirty`/`worktree-remove-failed` leave the handle in place; nothing else dismisses on those two. */
export type SessionDismissResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: 'unknown-session' | 'still-open' }
  | { readonly ok: false; readonly kind: 'worktree-dirty' }
  | { readonly ok: false; readonly kind: 'worktree-remove-failed'; readonly message: string }

/** `'session:restore'`'s response — `SessionStartResult`'s own branches plus the two ways a restore entry can fail to resolve. */
export type SessionRestoreResult =
  | SessionStartResult
  | { readonly ok: false; readonly kind: 'unknown-restore' }
  | { readonly ok: false; readonly kind: 'repo-unavailable'; readonly reason: string }

/** `'session:restore:discard'`'s response — always `{ ok: true }`, idempotent by design. */
export type SessionRestoreDiscardResult = { readonly ok: true }

// The model aliases an operator's session default may name.
export const SESSION_MODELS = ['opus', 'sonnet', 'haiku'] as const

export type SessionModel = (typeof SESSION_MODELS)[number]

// The exact permissionMode allowlist for an operator session — bypass, dontAsk, and auto are unreachable.
export const SESSION_PERMISSION_MODES = ['default', 'acceptEdits', 'plan'] as const

export type SessionPermissionMode = (typeof SESSION_PERMISSION_MODES)[number]

// An operator's persisted session defaults; `model: null` means Claude Code's own default.
export interface SessionDefaults {
  readonly model: SessionModel | null
  readonly permissionMode: SessionPermissionMode
}

export const DEFAULT_SESSION_DEFAULTS: SessionDefaults = { model: null, permissionMode: 'default' }

// A session's rename title ceiling, once trimmed.
export const SESSION_TITLE_MAX = 80

// `not-ready` is a handle with no claudeSessionId yet; the title changes only after the rename lands.
export type SessionRenameResult = { readonly ok: true } | { readonly ok: false; readonly kind: 'unknown-session' | 'not-ready' } | { readonly ok: false; readonly kind: 'rename-failed'; readonly message: string }

/** `'session:files'`'s response — `files` are forward-slashed, relative to `cwd`; a failed read is `unreadable`, never an empty list. */
export type SessionFilesResult =
  | { readonly ok: true; readonly files: readonly string[]; readonly truncated: boolean }
  | { readonly ok: false; readonly kind: 'unknown-session' }
  | { readonly ok: false; readonly kind: 'unreadable'; readonly message: string }
