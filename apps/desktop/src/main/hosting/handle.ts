import type { ProjectedDelta, ContentBlock } from '@/types/hosting'
import type { ExpectedComponents, UsageReading, PluginRequest } from '@/types/hosting-plugin'

// One hosted session: builds options, opens the query, runs the pump loop. The ring
// exists only so a renderer attaching mid-stream is not blank; the on-disk transcript is the history.
import type { CredentialsTell } from '@/types/runtime'
import type { HostedHandle } from '@/types/hosting'
import type { HostedQueryFn } from '@/main/hosting/sdk'
import type {
  HostedSessionSnapshot,
  SessionDefaults,
  SessionEnd,
  SessionEntriesDelta,
  SessionEventEnvelope,
  SessionHistory,
  SessionKey,
  SessionOrigin,
  SessionPhase,
  SessionRateLimit,
  SessionStartMode,
} from '@/types/hosting'
import type { RepoId } from '@/utils/repos'
import type { SessionWorkspace } from '@/types/workspace'
import type { SessionResult, StageTag } from '@/types/stage-session'
import { createHostedInput } from '@/main/hosting/input'
import { buildSessionOptions } from '@/main/hosting/options'
import { classifyEnd } from '@/main/hosting/classify'
import { createControlsTracker } from '@/main/hosting/controls'

import { createPermissionBroker } from '@/main/hosting/permissions'
import { stagePolicy } from '@/main/hosting/stage-policy'
import { createSessionProjector } from '@/main/hosting/project'

import { createCapabilityTracker } from '@/main/hosting/capabilities'
import { createTaskTracker } from '@/main/hosting/tasks'
import { readRateLimit } from '@/main/hosting/rate-limit'
import { readResult } from '@/main/hosting/result'
import { readUsage } from '@/main/hosting/usage'

import { promptTitle } from '@/main/hosting/title'
import { buildUserContent } from '@/main/hosting/content'

import { composeInvocation, validateCommandName } from '@/main/hosting/verify'

import type { SDKMessage } from '@/main/hosting/sdk'
import { pathOps } from '@/main/platform/paths'

export type { HostedQuery } from '@/main/hosting/sdk'

/** The bounded replay ring's size — never a growing per-session array. */
export const REPLAY_LIMIT = 500

/** How long `close()` waits for the generator to finish on its own after
 *  the input iterator ends, before forcing `query.close()`. */
export const CLOSE_GRACE_MS = 5_000

interface CreateHostedHandleParams {
  readonly sessionKey: SessionKey
  readonly repoId: RepoId | null
  readonly workspace: SessionWorkspace
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
  /** Read before spawn and kept frozen on the handle for its whole life. */
  readonly history: SessionHistory
  /** Non-null only for a stage session: carried on the snapshot, drives `buildSessionOptions`'s stage branch, and builds the `stagePolicy` the permission broker consults first. */
  readonly stage: { readonly tag: StageTag; readonly agentName: string; readonly model: string; readonly sessionRequiredPaths: readonly string[]; readonly editAllow: readonly string[]; readonly onDeny?: (toolName: string, input: Readonly<Record<string, unknown>>) => void } | null
}

interface HostedSendResult {
  readonly uuid: string
  readonly queued: boolean
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
  const controls = createControlsTracker({ defaults: params.defaults, onChange: () => emitStatus() })
  // Created before buildSessionOptions so an un-preapproved tool call routes through canUseTool, not a silent auto-deny.
  const broker = createPermissionBroker({
    now: params.now,
    onChange: () => emitStatus(),
    onPlanApproved: (mode) => controls.adoptApprovedMode(mode),
    ...(params.stage !== null ? { policy: stagePolicy({ cwd: params.cwd, sessionRequiredPaths: params.stage.sessionRequiredPaths, editAllow: params.stage.editAllow, pathOps }), onDeny: params.stage.onDeny } : {}),
  })
  const options = buildSessionOptions({
    mode: params.mode,
    cwd: params.cwd,
    executablePath: params.executablePath,
    canUseTool: broker.canUseTool,
    plugin: params.plugin,
    defaults: params.defaults,
    stage: params.stage !== null ? { agentName: params.stage.agentName, model: params.stage.model } : null,
  })
  const startedAt = new Date(params.now()).toISOString()
  const projector = createSessionProjector({ cwd: params.cwd })
  const capabilities = createCapabilityTracker({
    request: params.plugin,
    readExpectedComponents: params.readExpectedComponents,
    samePath: params.samePath,
    onChange: () => emitStatus(),
    stage: params.stage !== null,
  })
  const tasks = createTaskTracker()

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
  let usageReading: UsageReading | null = null
  let lastResult: SessionResult | null = null
  let operatorJoinedAt: string | null = null
  let closeRequested = false
  let seq = 0
  const ring: SessionEventEnvelope[] = []
  let droppedBefore = 0

  function snapshot(): HostedSessionSnapshot {
    return {
      sessionKey: params.sessionKey,
      claudeSessionId,
      repoId: params.repoId,
      workspace: params.workspace,
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
      controls: controls.current(),
      models: controls.models(),
      usage: usageReading?.usage ?? null,
      backgroundTasks: tasks.current(),
      stage: params.stage?.tag ?? null,
      lastResult,
      operatorJoinedAt,
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
    controls.observe(message)
    if (tasks.observe(message)) emitStatus()
    const observedAt = new Date(params.now()).toISOString()
    const reading = readRateLimit(message, observedAt)
    if (reading !== null) {
      rateLimit = reading
      emitStatus()
    }
    const nextUsage = readUsage(message, usageReading, observedAt)
    if (nextUsage !== usageReading) {
      usageReading = nextUsage
      // 'result' already emits below; only an assistant-driven change needs its own push.
      if (message.type === 'assistant') emitStatus()
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
      lastResult = readResult(message, observedAt)
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
  void controls.start(stream)

  async function pump(): Promise<void> {
    try {
      for await (const rawMessage of stream) {
        const message = rawMessage as SDKMessage
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
    // An ended session must never report a pending prompt or a stale background task.
    broker.cancelAll()
    tasks.reset()
    phase = 'ended'
    emitStatus()
  }

  /** `titleText`/`firstAttachmentName` back `promptTitle`'s own fallback —
   *  `invoke()` passes the composed `/name args` text and no attachment. */
  function doSend(content: string | ContentBlock[], titleText: string, firstAttachmentName: string | null): HostedSendResult {
    if (title === null) title = promptTitle(titleText, firstAttachmentName)
    const { uuid } = input.push(content)
    emitEntries(projector.recordSend(uuid, content, new Date(params.now()).toISOString()))
    // Streaming input mode accepts a send immediately; the CLI never echoes it back without --replay-user-messages.
    if (phase === 'starting' || phase === 'ready') phase = 'streaming'
    emitStatus()
    return { uuid, queued: true }
  }

  /** The first whitespace-delimited token, with its leading `/` stripped —
   *  `null` when the trimmed text does not start with `/`. */
  function leadingCommandName(text: string): string | null {
    const trimmed = text.trimStart()
    if (!trimmed.startsWith('/')) return null
    const token = trimmed.slice(1).split(/\s/, 1)[0]
    return token === undefined || token === '' ? null : token
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
    send(text, attachments = [], source = 'app') {
      const commandName = leadingCommandName(text)
      if (commandName !== null && capabilities.isBlocked(commandName)) {
        return { ok: false, kind: 'blocked-command', name: commandName }
      }
      const content = buildUserContent(text, attachments)
      const result = doSend(content, text, attachments[0]?.name ?? null)
      if (source === 'operator' && params.stage !== null && operatorJoinedAt === null) {
        operatorJoinedAt = new Date(params.now()).toISOString()
        emitStatus()
      }
      return { ok: true, ...result }
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
      const composed = composeInvocation(name, args)
      const { uuid } = doSend(composed, composed, null)
      return { ok: true, uuid, queued: true }
    },
    async setControls(patch) {
      if (phase === 'closing' || phase === 'ended') return { ok: false, kind: 'unknown-session' }
      if (claudeSessionId === null) return { ok: false, kind: 'not-ready' }
      return controls.set(stream, patch)
    },
    answerQuestion(permissionId, answers) {
      return broker.answerQuestion(permissionId, answers)
    },
    answerPlan(permissionId, decision) {
      return broker.answerPlan(permissionId, decision)
    },
    history() {
      return params.history
    },
    async stopTask(taskId) {
      if (phase === 'closing' || phase === 'ended') return { ok: false, kind: 'unknown-session' }
      if (!tasks.current().some((task) => task.taskId === taskId)) return { ok: false, kind: 'unknown-task' }
      try {
        await stream.stopTask(taskId)
        return { ok: true }
      } catch (error) {
        return { ok: false, kind: 'stop-failed', message: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
