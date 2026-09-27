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
 *  fork's own rename attempt failed — logged, never fatal. */
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
 *  trusting the replay as complete. */
export type SessionAttachResult =
  | { readonly ok: true; readonly snapshot: HostedSessionSnapshot; readonly replay: readonly SessionEventEnvelope[]; readonly droppedBefore: number }
  | { readonly ok: false; readonly kind: 'unknown-session' }
