// #98: `Map<sessionKey, Handle>`, the process-lifetime instance
// `main/ipc.ts` binds, plus `closeAll()`. `MAX_HOSTED_SESSIONS = 4`; a start
// past it returns `{ ok: false, kind: 'at-capacity', limit }` — counted
// against **live** handles only (`phase !== 'ended'`), since an ended
// handle's child process is already gone and the history stays visible for
// `session:list`/`session:attach` rather than disappearing the moment a
// session ends. Fails closed on the live count: each handle is a real child
// process with real memory, so refusing one start costs one message while
// not refusing costs an unbounded spawn loop.
import type { RepoId } from '../../shared/repos'
import type {
  HostedSessionSnapshot,
  SessionAttachResult,
  SessionCloseResult,
  SessionEventEnvelope,
  SessionInterruptResult,
  SessionKey,
  SessionSendResult,
  SessionStartMode,
  SessionStartResult,
} from '../../shared/hosting/types'
import { createHostedHandle } from './handle'
import type { HostedHandle, HostedQueryFn } from './handle'
import { createHostedSdk } from './sdk'
import type { HostedSdk } from './sdk'
import { defaultForkListSessions, titleFork } from './fork'
import type { SessionReader } from '../sessions/sdk'
import { readCredentialsTell, resolveClaudeExecutable } from '../runtime'

export const MAX_HOSTED_SESSIONS = 4

export interface HostedStoreDeps {
  readonly getSdk: () => Promise<HostedSdk>
  readonly resolveClaudeExecutable: typeof resolveClaudeExecutable
  readonly readCredentialsTell: typeof readCredentialsTell
  readonly listSessionsForFork: SessionReader
  readonly env: NodeJS.ProcessEnv
  readonly platform: NodeJS.Platform
  readonly now: () => number
  readonly onEvent: (envelope: SessionEventEnvelope) => void
  readonly onStatus: (snapshot: HostedSessionSnapshot) => void
}

export const defaultHostedStoreDeps: HostedStoreDeps = {
  getSdk: createHostedSdk(),
  resolveClaudeExecutable,
  readCredentialsTell,
  listSessionsForFork: defaultForkListSessions,
  env: process.env,
  platform: process.platform,
  now: () => Date.now(),
  onEvent: () => undefined,
  onStatus: () => undefined,
}

export interface StartSessionParams {
  readonly repoId: RepoId
  readonly mode: SessionStartMode
  /** The ready registry entry's own path — resolved by the caller
   *  (`main/channels/hosting.ts`), never re-derived here. */
  readonly cwd: string
}

export interface HostedStore {
  start(params: StartSessionParams): Promise<SessionStartResult>
  send(sessionKey: SessionKey, text: string): SessionSendResult
  interrupt(sessionKey: SessionKey): Promise<SessionInterruptResult>
  close(sessionKey: SessionKey): Promise<SessionCloseResult>
  attach(sessionKey: SessionKey): SessionAttachResult
  list(): readonly HostedSessionSnapshot[]
  closeAll(): Promise<void>
}

function toSessionKey(n: number): SessionKey {
  return `hosted-${n}` as SessionKey
}

export function createHostedStore(deps: HostedStoreDeps = defaultHostedStoreDeps): HostedStore {
  const handles = new Map<SessionKey, HostedHandle>()
  let nextId = 1

  function liveCount(): number {
    let count = 0
    for (const handle of handles.values()) {
      if (handle.snapshot().phase !== 'ended') count += 1
    }
    return count
  }

  async function start(params: StartSessionParams): Promise<SessionStartResult> {
    if (liveCount() >= MAX_HOSTED_SESSIONS) {
      return { ok: false, kind: 'at-capacity', limit: MAX_HOSTED_SESSIONS }
    }

    const located = await deps.resolveClaudeExecutable({ env: deps.env, platform: deps.platform })
    if (!located.ok) {
      return {
        ok: false,
        kind: 'runtime',
        diagnosis: located.kind === 'not-found' ? 'cli-missing' : 'bundled-fallback',
        detail: located.kind === 'bundled-fallback' ? located.path : null,
      }
    }

    const [credentials, sdk] = await Promise.all([deps.readCredentialsTell(), deps.getSdk()])
    const sessionKey = toSessionKey(nextId)
    nextId += 1
    const mode = params.mode
    const queryFn: HostedQueryFn = (queryParams) => sdk.query(queryParams)

    function onSessionId(claudeSessionId: string): void {
      if (mode.kind !== 'fork') return
      void titleFork(
        { parentSessionId: mode.sessionId, forkedSessionId: claudeSessionId, cwd: params.cwd },
        { listSessions: deps.listSessionsForFork, renameSession: sdk.renameSession },
      ).then((titled) => handles.get(sessionKey)?.setTitled(titled))
    }

    const handle = createHostedHandle(
      {
        sessionKey,
        repoId: params.repoId,
        mode,
        cwd: params.cwd,
        executablePath: located.path,
        credentials,
        now: deps.now,
        onEvent: deps.onEvent,
        onStatus: deps.onStatus,
        onSessionId,
      },
      queryFn,
    )
    handles.set(sessionKey, handle)
    return { ok: true, snapshot: handle.snapshot() }
  }

  function send(sessionKey: SessionKey, text: string): SessionSendResult {
    const handle = handles.get(sessionKey)
    if (!handle) return { ok: false, kind: 'unknown-session' }
    const result = handle.send(text)
    return { ok: true, uuid: result.uuid, queued: result.queued }
  }

  async function interrupt(sessionKey: SessionKey): Promise<SessionInterruptResult> {
    const handle = handles.get(sessionKey)
    if (!handle) return { ok: false, kind: 'unknown-session' }
    const queuedAfterInterrupt = await handle.interrupt()
    return { ok: true, queuedAfterInterrupt }
  }

  async function close(sessionKey: SessionKey): Promise<SessionCloseResult> {
    const handle = handles.get(sessionKey)
    if (!handle) return { ok: false, kind: 'unknown-session' }
    await handle.close()
    return { ok: true }
  }

  function attach(sessionKey: SessionKey): SessionAttachResult {
    const handle = handles.get(sessionKey)
    if (!handle) return { ok: false, kind: 'unknown-session' }
    const { events, droppedBefore } = handle.replay()
    return { ok: true, snapshot: handle.snapshot(), replay: events, droppedBefore }
  }

  function list(): readonly HostedSessionSnapshot[] {
    return [...handles.values()].map((handle) => handle.snapshot())
  }

  async function closeAll(): Promise<void> {
    await Promise.all([...handles.values()].map((handle) => handle.close()))
  }

  return { start, send, interrupt, close, attach, list, closeAll }
}
