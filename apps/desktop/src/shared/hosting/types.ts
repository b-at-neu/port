// Renderer-safe contract for a hosted session (#98). No import here may
// reach a Node builtin, the same rule `shared/runtime/types.ts` states for
// itself: `main/hosting/` is the only place that spawns a `claude` child or
// holds a `Query`, but the renderer is this contract's eventual consumer
// (#219), so this file compiles under `tsconfig.web.json` too. `message:
// unknown` on the event envelope is deliberate, not a gap — #219/#83 own
// every narrowing decision, one renderer for both, never a second one built
// against this file's own guess at the SDK's 37-variant union.
import type { RepoId } from '../repos'
import type { RuntimeDiagnosis } from '../runtime/types'
import type { EntryPatch, TranscriptEntry } from '../sessions/transcript'

declare const sessionKeyBrand: unique symbol

/** Minted only by `main/hosting/store.ts`, app-local (`hosted-<n>`) and
 *  never persisted — an app restart starts empty, so a stale key from a
 *  previous run can never name a live handle. Distinct from
 *  `claudeSessionId`: every IPC call names a session by this key, never by
 *  the SDK's own id (see "Two identifiers, never one" below). */
export type SessionKey = string & { readonly [sessionKeyBrand]: true }

/** Every phase a hosted session's handle can report, driven entirely by
 *  what the stream itself says (`init` → `ready`, a turn accepted →
 *  `streaming`, `result` → `ready`, terminal → `ended`) — never a guess. */
export type SessionPhase = 'starting' | 'ready' | 'streaming' | 'interrupting' | 'closing' | 'ended'

/** The four start modes the ticket names, uniform because of the one rule
 *  that makes them so: `sessionId` is minted at spawn, `claudeSessionId` is
 *  adopted only from the SDK's own `system`/`init` message — a fresh session
 *  has no id yet, a fork's id is new, a resume's is inherited, and the
 *  renderer never has to handle an id changing under it. `resumeDropsTurn`
 *  is `resume-at`-only (`Options.resumeSessionAt`'s own pairing) and `null`
 *  keeps the unvalidated truncation behaviour. */
export type SessionStartMode =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'resume'; readonly sessionId: string }
  | { readonly kind: 'resume-at'; readonly sessionId: string; readonly messageUuid: string; readonly resumeDropsTurn: string | null }
  | { readonly kind: 'fork'; readonly sessionId: string }

/** Lineage as reported on the snapshot — `forked` additionally carries
 *  `atMessageUuid` (`null` when the fork branched from the tip), so a
 *  renderer or #78's resumable list can distinguish a plain continuation
 *  from a branch without inspecting `SessionStartMode` itself. */
export type SessionOrigin =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'resumed'; readonly from: string }
  | { readonly kind: 'forked'; readonly from: string; readonly atMessageUuid: string | null }

/** Why a hosted session ended, from `classify.ts`'s own ladder over the
 *  SDK's own wordings. `resume-rejected` is the CLI's deterministic refusal
 *  of a `resumeDropsTurn` fork point — never retried, only rewound.
 *  Unrecognised text is `stream-error`, the message carried verbatim on
 *  `message`, never a guessed reason (same direction as #97's
 *  `probe-failed`). */
export type SessionEndReason = 'completed' | 'closed' | 'exit-nonzero' | 'signal' | 'process-error' | 'stream-error' | 'resume-rejected'

/** `diagnosis` is `classifyProbeFailure`'s own verdict over the same text —
 *  one failure vocabulary, not a second one at the lifecycle call site — and
 *  is `null` for the two reasons that are not failures (`completed`,
 *  `closed`) and for `resume-rejected`, which is a deterministic refusal
 *  rather than a diagnosable failure. */
export interface SessionEnd {
  readonly reason: SessionEndReason
  readonly exitCode: number | null
  readonly signal: string | null
  readonly message: string | null
  readonly diagnosis: RuntimeDiagnosis | null
}

/** The full state pushed on every phase change (`session:status`), never a
 *  delta — snapshots are small and a delta invites drift. `claudeSessionId`
 *  is `null` until `init` arrives. `queuedAfterInterrupt` is `null` when the
 *  CLI returned no receipt, reported as unknown, never as zero (ENGINEERING
 *  §4). `titled` is `null` for a non-fork session, and `false` only when a
 *  fork's own rename attempt failed — logged, never fatal. `pendingPermissions`
 *  (#99) is sorted oldest first; a prompt arriving mid-turn is not a new
 *  `SessionPhase` — the phase stays `streaming`, and #219 derives "awaiting
 *  a permission decision" from this list's length instead. It rides the
 *  snapshot rather than a second event stream so a renderer reload is
 *  lossless — the SDK gives permission prompts no park deadline, so one
 *  dropped by a reload would block the tool forever. */
export interface HostedSessionSnapshot {
  readonly sessionKey: SessionKey
  readonly claudeSessionId: string | null
  readonly repoId: RepoId
  readonly phase: SessionPhase
  readonly origin: SessionOrigin
  readonly startedAt: string
  readonly queuedAfterInterrupt: number | null
  readonly end: SessionEnd | null
  readonly titled: boolean | null
  readonly pendingPermissions: readonly PendingPermission[]
  /** #101: the Pipeline strip's own state — rides this snapshot rather than
   *  a second event stream, the same reasoning `pendingPermissions` already
   *  states for itself. */
  readonly capabilities: SessionCapabilities
  /** #103: the session's own display title — set once from the first
   *  prompt (or, for a resume/fork, resolved before spawn) and never
   *  changed after it goes non-null, so a label never shifts under the
   *  operator. `null` until then; `sessionDisplayLabel` (`shared/hosting/
   *  label.ts`) is what turns this into what the rail and the permission
   *  dialog actually show. */
  readonly title: string | null
  /** #103: the newest reading `main/hosting/rate-limit.ts` narrowed off a
   *  `rate_limit_event` message — `null` until the first one arrives, never
   *  synthesized. */
  readonly rateLimit: SessionRateLimit | null
}

/** `session:event`'s payload — the SDK message crosses the boundary opaque
 *  (`message: unknown`); this app does not narrow it, does not interpret
 *  instructions inside it, and does not execute anything it contains.
 *  `seq` is monotonic per session, `receivedAt` is this process's own clock,
 *  never the SDK's. */
export interface SessionEventEnvelope {
  readonly sessionKey: SessionKey
  readonly seq: number
  readonly receivedAt: string
  readonly message: unknown
}

/** `'session:start'`'s response — `at-capacity` names the limit
 *  (`MAX_HOSTED_SESSIONS`) rather than a bare refusal, and `runtime` carries
 *  #97's own `RuntimeDiagnosis`/`detail`, never a new error vocabulary. */
export type SessionStartResult =
  | { readonly ok: true; readonly snapshot: HostedSessionSnapshot }
  | { readonly ok: false; readonly kind: 'at-capacity'; readonly limit: number }
  | { readonly ok: false; readonly kind: 'runtime'; readonly diagnosis: RuntimeDiagnosis; readonly detail: string | null }
  /** #103: a `resume`/`resume-at` whose `sessionId` already names a live
   *  handle — fails closed, since two `claude` processes appending to one
   *  transcript is unrecoverable. `sessionKey` is that existing handle's, so
   *  a caller (the rail, the restore banner, the Transcripts picker) can
   *  switch to it rather than merely reporting the refusal. */
  | { readonly ok: false; readonly kind: 'already-open'; readonly sessionKey: SessionKey }

/** `'session:send'`'s response — always `queued` rather than refusing
 *  mid-turn (the SDK owns the queue), or `unknown-session` when the key
 *  names no live handle. */
export type SessionSendResult = { readonly ok: true; readonly uuid: string; readonly queued: boolean } | { readonly ok: false; readonly kind: 'unknown-session' }

/** `'session:interrupt'`'s response — `queuedAfterInterrupt` is `null`
 *  exactly when the CLI's own receipt carried none, never coerced to `0`. */
export type SessionInterruptResult = { readonly ok: true; readonly queuedAfterInterrupt: number | null } | { readonly ok: false; readonly kind: 'unknown-session' }

export type SessionCloseResult = { readonly ok: true } | { readonly ok: false; readonly kind: 'unknown-session' }

/** `'session:attach'`'s response — the reconnect path after a renderer
 *  reload; handles are main-process-owned and survive it. `replay` is a
 *  bounded window (`REPLAY_LIMIT`), never the whole session; `droppedBefore`
 *  is how a consumer knows to fall back to the transcript reader instead of
 *  trusting the replay as complete.
 *
 *  #219's own window rides alongside `replay`, never replacing it —
 *  `entries`/`firstIndex` are the projector's own bounded ring
 *  (`ENTRY_RETAIN_LIMIT`), `partial` is the live streaming block's current
 *  state (`null` when nothing is mid-stream), `pendingSends` the sent-but-
 *  unacknowledged prompt uuids, and `revision` the projector's own monotonic
 *  counter — a gap between this and a later `session:entries` push is the
 *  renderer's own re-attach signal (`session/sequence.ts`). */
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

/** #219: a streaming text/thinking block's own kind — never a third value,
 *  since a tool call's input JSON is never streamed (see `main/hosting/
 *  project.ts`'s own "Tool-input JSON deltas are not streamed" rule). */
export type LiveBlockKind = 'text' | 'thinking'

/** #219: one streaming block's accumulated state, as reconnect
 *  (`session:attach`) and the renderer's own live row both need it —
 *  `blockId` is `<messageId>:<contentBlockIndex>`, never a tool call's own
 *  id, so it stays stable across a block that has no tool call at all.
 *  `omittedChars` mirrors `Payload`'s own
 *  truncation signal once the block's accumulated text reaches
 *  `MAX_PAYLOAD_CHARS` — best-effort during the stream itself; the eventual
 *  on-disk-shaped entry the deriver produces from the completed message is
 *  the exact count. */
export interface LiveBlock {
  readonly blockId: string
  readonly kind: LiveBlockKind
  readonly text: string
  readonly omittedChars: number
}

/** #219: the operation `session:entries`' own `partial` field carries —
 *  never the whole accumulated block (that would repeat every prior chunk on
 *  every delta). `append` both opens a new block (an empty `text`, on the
 *  block's first appearance) and grows an existing one; `clear` is every
 *  place project.ts's own "clears" rules fire — a stopped block's matching
 *  `assistant` message, or any `result`. */
export type PartialUpdate = { readonly op: 'append'; readonly blockId: string; readonly kind: LiveBlockKind; readonly text: string } | { readonly op: 'clear' }

/** `'session:entries'`'s push payload (#219) — the live projection's own
 *  delta, in the same `appended`/`patched` shape #84's tail poll already
 *  gives a transcript reader, so the renderer's `entry-list.ts` applies both
 *  through one code path. `revision` is monotonic per session; a gap means
 *  re-attach (`session/sequence.ts`). `partial` is `null` when no streaming
 *  block changed this delta; `pendingSends` is `null` when the sent-but-
 *  unacknowledged uuid set did not change, never re-sent unchanged. */
export interface SessionEntriesDelta {
  readonly sessionKey: SessionKey
  readonly revision: number
  readonly appended: readonly TranscriptEntry[]
  readonly patched: readonly EntryPatch[]
  readonly partial: PartialUpdate | null
  readonly pendingSends: readonly string[] | null
}

/** #99: the three decisions the operator can send back for a pending
 *  permission request. `allow-session` is offered only when the request's
 *  own `sessionGrant` is non-null. */
export const PERMISSION_DECISIONS = ['allow-once', 'allow-session', 'deny'] as const

export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number]

/** What "allow for this session" would grant, narrowed and renderer-safe —
 *  never the SDK's own `PermissionUpdate` (see "Never crosses the boundary"
 *  below). One line of dialog copy per kind, `renderer/src/permission/
 *  copy.ts`'s own `grantLines`. */
export type SessionGrantItem =
  | { readonly kind: 'rule'; readonly toolName: string; readonly ruleContent: string | null }
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'accept-edits' }

/** One pending `canUseTool` call, as the renderer sees it — `permissionId`
 *  is app-minted (`main/hosting/permissions.ts`'s own `crypto.randomUUID()`),
 *  never the SDK's own `requestId`/`toolUseID`, which never cross this
 *  boundary. `input` is verbatim and untrusted: rendered as text only, never
 *  interpreted. `sessionGrant` is `null` when the SDK offered nothing worth
 *  a session-wide grant — the dialog then omits "allow for this session"
 *  entirely, with no explanatory filler. */
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
}

/** `'session:permission:answer'`'s response. `unknown-session`/
 *  `unknown-permission` are ordinary races an operator can hit (a second
 *  window, a withdrawn request) — reported as values, never thrown.
 *  `no-session-grant` is `allow-session` sent for a request whose
 *  `sessionGrant` is `null`; nothing is settled in either case. */
export type SessionPermissionAnswerResult = { readonly ok: true } | { readonly ok: false; readonly kind: 'unknown-session' | 'unknown-permission' | 'no-session-grant' }

/** #101: which plugin path a session asked for — the repository's own
 *  `plugins/port/` (this checkout, self-hosting) or the operator's installed
 *  copy (`port@port` from `enabledPlugins`). Resolved once, before spawn
 *  (`main/hosting/plugin.ts`'s `resolvePluginRequest`), and carried on the
 *  snapshot so the operator can see which copy a session asked for even
 *  before `init` confirms what actually loaded. */
export type PluginRequest = { readonly source: 'repository'; readonly path: string } | { readonly source: 'installed' }

/** #101: what actually loaded, read back from the SDK rather than assumed —
 *  "a malformed component is *absent* from the inventory rather than
 *  reported as an error" (ENGINEERING §7) is exactly the failure mode this
 *  guards against for the plugin load itself. `unconfirmed` is the state
 *  before any `init` has arrived — the repository copy's own component
 *  check can already run by then (`readExpectedComponents` reads from
 *  `request.path` directly), but the load state itself waits for the wire. */
export type PluginLoad =
  | { readonly kind: 'unconfirmed' }
  | { readonly kind: 'loaded'; readonly path: string; readonly version: string | null }
  | { readonly kind: 'missing' }
  | { readonly kind: 'shadowed'; readonly path: string; readonly version: string | null }
  | { readonly kind: 'duplicate'; readonly paths: readonly string[] }

/** #101: whether the loaded plugin's skills/agents match what the plugin
 *  directory itself declares — `unchecked` when the directory could not be
 *  read (never reported as `complete`, ENGINEERING's "fails closed on
 *  complete" direction), `complete` when everything expected showed up in
 *  the reported commands/agents, `incomplete` naming exactly what did not. */
export type ComponentCheck =
  | { readonly kind: 'unchecked'; readonly reason: 'no-plugin-path' | 'unreadable' }
  | { readonly kind: 'complete' }
  | { readonly kind: 'incomplete'; readonly missingSkills: readonly string[]; readonly missingAgents: readonly string[] }

/** #101: one `port:` slash command, renderer-safe — `description` goes
 *  through `sanitize` (author-controlled plugin text) before it ever
 *  reaches this shape. */
export interface CommandSummary {
  readonly name: string
  readonly description: string
  readonly argumentHint: string
}

/** #101: one `port:` agent, renderer-safe — `model` is `null` when the
 *  agent's own frontmatter names none (inherits the parent's). */
export interface AgentSummary {
  readonly name: string
  readonly description: string
  readonly model: string | null
}

/** #101: the Pipeline strip's own state, read back from the session rather
 *  than assumed the moment a plugin request is resolved — `pending` before
 *  the capability read settles, `unavailable` when it timed out or the SDK
 *  call rejected (never an empty list standing in for either), `ready`
 *  otherwise, carrying the plugin load and component check alongside the
 *  filtered, sorted `port:` command/agent lists. */
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
    }

/** #101: `'session:invoke'`'s response — a typed refusal for a name that
 *  fails the SDK's own canonical-name rules or that this session's current
 *  command list does not carry, alongside `SessionSendResult`'s own ok
 *  branch and `unknown-session` (the same reading a gone key already gets
 *  everywhere else in this file). */
export type SessionInvokeResult =
  | { readonly ok: true; readonly uuid: string; readonly queued: boolean }
  | { readonly ok: false; readonly kind: 'unknown-session' }
  | { readonly ok: false; readonly kind: 'invalid-command'; readonly reason: string }
  | { readonly ok: false; readonly kind: 'unknown-command'; readonly name: string }

/** #103: a `rate_limit_event` narrowed structurally by `main/hosting/
 *  rate-limit.ts` — `utilization` is deliberately not read, since its unit
 *  is undocumented in SDK 0.3.261 and a percentage in the wrong unit is
 *  misinformation. `observedAt` is this process's own clock, never the
 *  SDK's. */
export interface SessionRateLimit {
  readonly status: 'allowed' | 'warning' | 'rejected'
  readonly window: 'five-hour' | 'weekly' | 'weekly-opus' | 'weekly-sonnet' | 'overage' | null
  readonly resetsAt: string | null
  readonly observedAt: string
}

/** #103: `'session:capacity'`/`'session:capacity:set'`'s own shape —
 *  `ceiling` (`SESSION_LIMIT_CEILING`) never changes, `limit` is the
 *  operator's own setting, persisted. */
export interface HostingCapacity {
  readonly limit: number
  readonly ceiling: number
}

/** #103: one entry offered by the restore banner at boot — app-minted
 *  (`restoreId`), never the persisted `claudeSessionId` itself, so the
 *  renderer can never send that id back verbatim. `availability` is the
 *  registry's own read, resolved by `main/channels/hosting.ts`. */
export interface RestorableSession {
  readonly restoreId: string
  readonly repoId: RepoId
  readonly title: string | null
  readonly origin: { readonly kind: 'resumed'; readonly from: string }
  readonly startedAt: string
  readonly availability: { readonly ok: true } | { readonly ok: false; readonly reason: string }
}

/** `'session:dismiss'`'s response — an ended handle's row leaving the rail. */
export type SessionDismissResult = { readonly ok: true } | { readonly ok: false; readonly kind: 'unknown-session' | 'still-open' }

/** `'session:restore'`'s response — `SessionStartResult`'s own branches plus
 *  the two ways a restore entry itself can fail to resolve. */
export type SessionRestoreResult =
  | SessionStartResult
  | { readonly ok: false; readonly kind: 'unknown-restore' }
  | { readonly ok: false; readonly kind: 'repo-unavailable'; readonly reason: string }

/** `'session:restore:discard'`'s response — always `{ ok: true }`, since
 *  discarding an already-gone entry (or every entry with `null`) is
 *  idempotent by design. */
export type SessionRestoreDiscardResult = { readonly ok: true }

// The model aliases an operator's session default may name, the same alias style DISPATCHER_MODEL uses.
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
