// One hosted session: builds options, opens the query, runs the pump loop. The ring
// exists only so a renderer attaching mid-stream is not blank; the on-disk transcript is the history.
import type { CredentialsTell } from '../../shared/runtime/types'
import type {
  HostedSessionSnapshot,
  PermissionDecision,
  PluginRequest,
  SessionDefaults,
  SessionEnd,
  SessionEntriesDelta,
  SessionEventEnvelope,
  SessionInvokeResult,
  SessionKey,
  SessionOrigin,
  SessionPermissionAnswerResult,
  SessionPhase,
  SessionRateLimit,
  SessionStartMode,
} from '../../shared/hosting/types'
import type { RepoId } from '../../shared/repos'
import { createHostedInput } from './input'
import { buildSessionOptions } from './options'
import { classifyEnd } from './classify'
import { createPermissionBroker } from './permissions'
import { createSessionProjector } from './project'
import type { ProjectedDelta, SessionProjectorWindow } from './project'
import { createCapabilityTracker } from './capabilities'
import { readRateLimit } from './rate-limit'
import { promptTitle } from './title'
import { composeInvocation, validateCommandName } from './verify'
import type { ExpectedComponents } from './plugin'
import type { HostedQuery, Options, SDKMessage, SDKUserMessage } from './sdk'

export type { HostedQuery } from './sdk'

/** The bounded replay ring's size — never a growing per-session array. */
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
  /** Which plugin path this session asked for, resolved once before spawn. */
  readonly plugin: PluginRequest
  readonly readExpectedComponents: (pluginPath: string) => Promise<ExpectedComponents | null>
  readonly samePath: (a: string, b: string) => boolean
  /** The restore path's own resolved title, `null` otherwise; set once and never overwritten. */
  readonly initialTitle: string | null
  readonly defaults: SessionDefaults
  /** Fired exactly once, the first time `init` reports the real `claudeSessionId`. */
  readonly onSessionId?: (claudeSessionId: string) => void
  /** One delta per message that produced a visible change, plus one per `send()`. */
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
  /** `mode.sessionId` for `resume`/`resume-at`, `null` otherwise. */
  readonly resumeTarget: string | null
  readonly cwd: string
  snapshot(): HostedSessionSnapshot
  replay(): HostedHandleReplay
  /** Always accepts and returns `{ uuid, queued: true }` — the SDK owns the queue. */
  send(text: string): HostedSendResult
  /** The interrupt receipt's `still_queued` count, or `null` when the CLI returned no receipt. */
  interrupt(): Promise<number | null>
  /** Ends the input iterator, waits up to `CLOSE_GRACE_MS`, then forces `query.close()`. */
  close(): Promise<void>
  setTitled(titled: boolean): void
  /** Fills `title` only while it is still `null`. */
  setTitle(title: string): void
  /** Unlike `setTitle`, sets `title` unconditionally. */
  rename(title: string): void
  answerPermission(permissionId: string, decision: PermissionDecision, message: string | null): SessionPermissionAnswerResult
  entriesWindow(): SessionProjectorWindow
  /** `invalid-command` on a malformed name, `unknown-command` outside this session's `port:` list. */
  invoke(name: string, args: string): SessionInvokeResult
}

function resumeTargetFor(mode: SessionStartMode): string | null {
  return mode.kind === 'resume' || mode.kind === 'resume-at' ? mode.sessionId : null
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

/** A runtime-native deadline, never a manually scheduled callback. */
function grace(ms: number): Promise<void> {
  return new Promise((resolve) => {
    AbortSignal.timeout(ms).addEventListener('abort', () => resolve(), { once: true })
  })
}

export function createHostedHandle(params: CreateHostedHandleParams, query: HostedQueryFn): HostedHandle {
  const input = createHostedInput()
  // Created before buildSessionOptions so an un-preapproved tool call routes through canUseTool, not a silent auto-deny.
  const broker = createPermissionBroker({ now: params.now, onChange: () => emitStatus() })
  const options = buildSessionOptions({ mode: params.mode, cwd: params.cwd, executablePath: params.executablePath, canUseTool: broker.canUseTool, plugin: params.plugin, defaults: params.defaults })
  const startedAt = new Date(params.now()).toISOString()
  const projector = createSessionProjector({ cwd: params.cwd })
  const capabilities = createCapabilityTracker({
    request: params.plugin,
    readExpectedComponents: params.readExpectedComponents,
    samePath: params.samePath,
    onChange: () => emitStatus(),
  })

  function emitEntries(delta: ProjectedDelta | null): void {
    if (delta === null) return
    params.onEntries?.({ sessionKey: params.sessionKey, ...delta })
  }

  let phase: SessionPhase = 'starting'
  let claudeSessionId: string | null = null
  let queuedAfterInterrupt: number | null = null
  let end: SessionEnd | null = null
  let titled: boolean | null = null
  let title: string | null = params.initialTitle
  let rateLimit: SessionRateLimit | null = null
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
      capabilities: capabilities.current(),
      title,
      rateLimit,
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

  /** Read structurally rather than narrowing to `SDKResultMessage` first — both result variants agree on the field's shape. */
  function queuedTurnCountOf(message: SDKMessage): number | undefined {
    return 'queued_turn_count' in message ? (message as { queued_turn_count?: number }).queued_turn_count : undefined
  }

  function applyMessage(message: SDKMessage): void {
    capabilities.observe(message)
    const observedAt = new Date(params.now()).toISOString()
    const reading = readRateLimit(message, observedAt)
    if (reading !== null) {
      rateLimit = reading
      emitStatus()
    }
    if (message.type === 'system' && message.subtype === 'init') {
      const firstInit = claudeSessionId === null
      claudeSessionId = message.session_id
      // Only 'starting' -> 'ready' is assigned here, so a send() already in 'streaming' stays there.
      if (phase === 'starting') phase = 'ready'
      emitStatus()
      if (firstInit) params.onSessionId?.(message.session_id)
      return
    }
    if (message.type === 'result') {
      const queuedTurnCount = queuedTurnCountOf(message)
      // A positive queued_turn_count means the next turn already dequeued, so the session is still working.
      if ((phase === 'streaming' || phase === 'interrupting') && !(typeof queuedTurnCount === 'number' && queuedTurnCount > 0)) {
        phase = 'ready'
      }
      emitStatus()
    }
  }

  // buildSessionOptions sets pathToClaudeCodeExecutable unconditionally, never the SDK's own bundled fallback.
  const stream = query({ prompt: input.stream, options })
  void capabilities.start(stream)

  async function pump(): Promise<void> {
    try {
      for await (const message of stream) {
        const receivedAt = new Date(params.now()).toISOString()
        pushEnvelope(message, receivedAt)
        applyMessage(message)
        // A throw here must never stop the pump — the on-disk transcript still holds the envelope.
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
    // An ended session must never report a pending prompt.
    broker.cancelAll()
    phase = 'ended'
    emitStatus()
  }

  function doSend(text: string): HostedSendResult {
    if (title === null) title = promptTitle(text)
    const { uuid } = input.push(text)
    emitEntries(projector.recordSend(uuid, text, new Date(params.now()).toISOString()))
    // Streaming input mode accepts a send immediately; the CLI never echoes it back without --replay-user-messages.
    if (phase === 'starting' || phase === 'ready') phase = 'streaming'
    emitStatus()
    return { uuid, queued: true }
  }

  const pumpDone = pump()

  return {
    sessionKey: params.sessionKey,
    resumeTarget: resumeTargetFor(params.mode),
    cwd: params.cwd,
    snapshot,
    replay() {
      return { events: [...ring], droppedBefore }
    },
    send(text) {
      return doSend(text)
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
    setTitle(value) {
      if (title !== null) return
      title = value
      emitStatus()
    },
    rename(value) {
      title = value
      emitStatus()
    },
    answerPermission(permissionId, decision, message) {
      return broker.answer(permissionId, decision, message)
    },
    entriesWindow() {
      return projector.window()
    },
    invoke(name, args) {
      if (phase === 'closing' || phase === 'ended') return { ok: false, kind: 'unknown-session' }
      const validation = validateCommandName(name)
      if (!validation.ok) return { ok: false, kind: 'invalid-command', reason: validation.reason }
      if (!capabilities.has(name)) return { ok: false, kind: 'unknown-command', name }
      const { uuid } = doSend(composeInvocation(name, args))
      return { ok: true, uuid, queued: true }
    },
  }
}
