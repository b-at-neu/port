// #98: one hosted session — builds options, opens the query, and runs the
// pump loop. Each message is wrapped in an envelope with a monotonic `seq`,
// pushed immediately, and appended to a bounded ring of the last
// `REPLAY_LIMIT` envelopes, never a growing per-session array. Phase
// transitions come from what the stream itself says: `init` → `ready`, a
// user turn accepted → `streaming`, `result` → `ready`, terminal → `ended`.
//
// The on-disk transcript is the history; the event stream is the live edge
// — `persistSession: true` means #84's tail already holds the full record,
// so the ring exists only so a renderer attaching mid-stream is not blank.
import type { CredentialsTell } from '../../shared/runtime/types'
import type {
  HostedSessionSnapshot,
  PermissionDecision,
  SessionEnd,
  SessionEntriesDelta,
  SessionEventEnvelope,
  SessionKey,
  SessionOrigin,
  SessionPermissionAnswerResult,
  SessionPhase,
  SessionStartMode,
} from '../../shared/hosting/types'
import type { RepoId } from '../../shared/repos'
import { createHostedInput } from './input'
import { buildSessionOptions } from './options'
import { classifyEnd } from './classify'
import { createPermissionBroker } from './permissions'
import { createSessionProjector } from './project'
import type { ProjectedDelta, SessionProjectorWindow } from './project'
import type { HostedQuery, Options, SDKMessage, SDKUserMessage } from './sdk'

export type { HostedQuery } from './sdk'

/** The bounded replay ring's size — never a growing per-session array
 *  (ENGINEERING §7's "small, focused" rule applied to memory, not just
 *  files). */
export const REPLAY_LIMIT = 500

/** How long `close()` waits for the generator to finish on its own after
 *  the input iterator ends, before forcing `query.close()`. */
export const CLOSE_GRACE_MS = 5_000

export type HostedQueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => HostedQuery

export interface CreateHostedHandleParams {
  readonly sessionKey: SessionKey
  readonly repoId: RepoId
  readonly mode: SessionStartMode
  readonly cwd: string
  readonly executablePath: string
  readonly credentials: CredentialsTell | null
  readonly now: () => number
  readonly onEvent: (envelope: SessionEventEnvelope) => void
  readonly onStatus: (snapshot: HostedSessionSnapshot) => void
  /** Fired exactly once, the first time `init` reports the real
   *  `claudeSessionId` — `main/hosting/store.ts` uses this to kick off
   *  `fork.ts`'s titling for a `fork`-mode handle, never fired synchronously
   *  from inside `createHostedHandle` itself. */
  readonly onSessionId?: (claudeSessionId: string) => void
  /** #219: this handle's own projector delta, one per message that produced
   *  a visible change, plus one for every `send()`. Optional the same way
   *  `onSessionId` is — a caller that never wires it just never gets it. */
  readonly onEntries?: (delta: SessionEntriesDelta) => void
}

export interface HostedHandleReplay {
  readonly events: readonly SessionEventEnvelope[]
  readonly droppedBefore: number
}

export interface HostedSendResult {
  readonly uuid: string
  readonly queued: boolean
}

export interface HostedHandle {
  readonly sessionKey: SessionKey
  snapshot(): HostedSessionSnapshot
  replay(): HostedHandleReplay
  /** Always accepts and returns `{ uuid, queued: true }` — the SDK owns the
   *  queue, and a lock in the main process could only ever be a stale
   *  guess. */
  send(text: string): HostedSendResult
  /** Resolves to the interrupt receipt's `still_queued` count, or `null`
   *  when the CLI returned no receipt — an absent signal is never read as
   *  zero (ENGINEERING §4). */
  interrupt(): Promise<number | null>
  /** Ends the input iterator, waits up to `CLOSE_GRACE_MS` for the
   *  generator to finish on its own, then forces `query.close()`. */
  close(): Promise<void>
  /** `fork.ts`'s own titling result — `false` only when the rename attempt
   *  failed; logged there, never retried and never fatal here. */
  setTitled(titled: boolean): void
  /** #99: delegates to this handle's own permission broker — the id is
   *  resolved only within this handle, so a permissionId from another
   *  session's broker can never settle a prompt here. */
  answerPermission(permissionId: string, decision: PermissionDecision, message: string | null): SessionPermissionAnswerResult
  /** #219: the live projector's own bounded window — `session:attach`'s ok
   *  branch spreads this alongside the raw envelope replay. */
  entriesWindow(): SessionProjectorWindow
}

function originFor(mode: SessionStartMode): SessionOrigin {
  switch (mode.kind) {
    case 'fresh':
      return { kind: 'fresh' }
    case 'resume':
      return { kind: 'resumed', from: mode.sessionId }
    case 'resume-at':
      return { kind: 'resumed', from: mode.sessionId }
    case 'fork':
      return { kind: 'forked', from: mode.sessionId, atMessageUuid: null }
  }
}

/** A runtime-native deadline via the standard `AbortSignal` factory, the
 *  same idiom `runtime/sdk.ts`'s probe uses for its own bounded wait —
 *  never a manually scheduled callback of this app's own (`main/state/
 *  watcher.ts` is the only file allowed to name one, #80 Decision 2; a
 *  bounded close-grace wait is not that clock). */
function grace(ms: number): Promise<void> {
  return new Promise((resolve) => {
    AbortSignal.timeout(ms).addEventListener('abort', () => resolve(), { once: true })
  })
}

export function createHostedHandle(params: CreateHostedHandleParams, query: HostedQueryFn): HostedHandle {
  const input = createHostedInput()
  // #99: created before buildSessionOptions, whose 'default' permissionMode
  // (never 'dontAsk') routes an un-preapproved tool call through this
  // broker's own canUseTool rather than a silent auto-deny.
  const broker = createPermissionBroker({ now: params.now, onChange: () => emitStatus() })
  const options = buildSessionOptions({ mode: params.mode, cwd: params.cwd, executablePath: params.executablePath, canUseTool: broker.canUseTool })
  const startedAt = new Date(params.now()).toISOString()
  const projector = createSessionProjector({ cwd: params.cwd })

  function emitEntries(delta: ProjectedDelta | null): void {
    if (delta === null) return
    params.onEntries?.({ sessionKey: params.sessionKey, ...delta })
  }

  let phase: SessionPhase = 'starting'
  let claudeSessionId: string | null = null
  let queuedAfterInterrupt: number | null = null
  let end: SessionEnd | null = null
  let titled: boolean | null = null
  let closeRequested = false
  let seq = 0
  const ring: SessionEventEnvelope[] = []
  let droppedBefore = 0

  function snapshot(): HostedSessionSnapshot {
    return {
      sessionKey: params.sessionKey,
      claudeSessionId,
      repoId: params.repoId,
      phase,
      origin: originFor(params.mode),
      startedAt,
      queuedAfterInterrupt,
      end,
      titled,
      pendingPermissions: broker.pending(),
    }
  }

  function emitStatus(): void {
    params.onStatus(snapshot())
  }

  function pushEnvelope(message: unknown, receivedAt: string): void {
    seq += 1
    const envelope: SessionEventEnvelope = { sessionKey: params.sessionKey, seq, receivedAt, message }
    ring.push(envelope)
    if (ring.length > REPLAY_LIMIT) {
      ring.shift()
      droppedBefore += 1
    }
    params.onEvent(envelope)
  }

  /** `queued_turn_count` rides only the two `result` variants, never the
   *  wider `SDKMessage` union — read structurally rather than narrowing
   *  `message` to `SDKResultMessage` first, since both branches already
   *  agree on the field's shape. */
  function queuedTurnCountOf(message: SDKMessage): number | undefined {
    return 'queued_turn_count' in message ? (message as { queued_turn_count?: number }).queued_turn_count : undefined
  }

  function applyMessage(message: SDKMessage): void {
    if (message.type === 'system' && message.subtype === 'init') {
      const firstInit = claudeSessionId === null
      claudeSessionId = message.session_id
      // Never demotes a send that raced it: only 'starting' -> 'ready' is
      // ever assigned here, so a send() that already moved the phase to
      // 'streaming' stays there.
      if (phase === 'starting') phase = 'ready'
      emitStatus()
      if (firstInit) params.onSessionId?.(message.session_id)
      return
    }
    if (message.type === 'result') {
      const queuedTurnCount = queuedTurnCountOf(message)
      // Only drops back to 'ready' when nothing is still queued -- a
      // positive queued_turn_count means the next turn has already been
      // dequeued, so the session is still working.
      if ((phase === 'streaming' || phase === 'interrupting') && !(typeof queuedTurnCount === 'number' && queuedTurnCount > 0)) {
        phase = 'ready'
      }
      emitStatus()
    }
  }

  // `options` always carries `pathToClaudeCodeExecutable` — `buildSessionOptions`
  // (`./options`) sets it unconditionally, never left to the SDK's own
  // bundled fallback (the same rail `desktop-runtime`'s own guard pins for
  // every real `query({` call site).
  const stream = query({ prompt: input.stream, options })

  async function pump(): Promise<void> {
    try {
      for await (const message of stream) {
        const receivedAt = new Date(params.now()).toISOString()
        pushEnvelope(message, receivedAt)
        applyMessage(message)
        // A throw here must never stop the pump or drop the envelope this
        // message already got forwarded through above — the on-disk
        // transcript still holds it, so this app fails open on the session
        // and closed on one row.
        try {
          emitEntries(projector.push(message, receivedAt))
        } catch (error) {
          console.error(`[hosting] projector threw for session ${params.sessionKey}`, error)
        }
      }
      end = { reason: 'completed', exitCode: null, signal: null, message: null, diagnosis: null }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      const classified = classifyEnd({ text, closeRequested, credentials: params.credentials, now: params.now() })
      end = { reason: classified.reason, exitCode: classified.exitCode, signal: classified.signal, message: text, diagnosis: classified.diagnosis }
    }
    // An ended session must never report a pending prompt, even if the SDK
    // never fires the abort signals itself.
    broker.cancelAll()
    phase = 'ended'
    emitStatus()
  }

  const pumpDone = pump()

  return {
    sessionKey: params.sessionKey,
    snapshot,
    replay() {
      return { events: [...ring], droppedBefore }
    },
    send(text) {
      const { uuid } = input.push(text)
      emitEntries(projector.recordSend(uuid, text, new Date(params.now()).toISOString()))
      // Streaming input mode means a send is always accepted immediately --
      // moved here rather than waiting for the stream to echo it back,
      // since the CLI never does that unless started with
      // --replay-user-messages, which options.ts does not pass.
      if (phase === 'starting' || phase === 'ready') phase = 'streaming'
      emitStatus()
      return { uuid, queued: true }
    },
    async interrupt() {
      if (phase === 'ended') return queuedAfterInterrupt
      phase = 'interrupting'
      emitStatus()
      const receipt = await stream.interrupt()
      queuedAfterInterrupt = receipt === undefined ? null : receipt.still_queued.length
      emitStatus()
      return queuedAfterInterrupt
    },
    async close() {
      if (phase === 'ended') return
      closeRequested = true
      phase = 'closing'
      emitStatus()
      input.end()
      await Promise.race([pumpDone, grace(CLOSE_GRACE_MS)])
      stream.close()
      await pumpDone.catch(() => undefined)
    },
    setTitled(value) {
      titled = value
      emitStatus()
    },
    answerPermission(permissionId, decision, message) {
      return broker.answer(permissionId, decision, message)
    },
    entriesWindow() {
      return projector.window()
    },
  }
}
