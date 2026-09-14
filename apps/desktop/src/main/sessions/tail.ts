// The tail store (#84): one Map<tailId, TailState> in main, giving the
// renderer a follow primitive over openTranscript/advanceTranscript without
// ever exposing a TranscriptCursor -- main-process-only, per transcript.ts --
// across IPC. tailId is a module-local counter (tail-<n>), not randomUUID:
// no node:crypto import is needed for an opaque token whose whole scope is
// one main process.
import type { TranscriptTailOpen, TranscriptTailPoll } from '../../shared/sessions/transcript'
import { advanceTranscript, openTranscript } from './transcript'
import type { OpenTranscriptParams, TranscriptCursor } from './transcript'

/** Swept lazily at the head of every `open` and `poll` -- no `setInterval`
 *  and no `webContents` bookkeeping. A renderer reload or a closed window
 *  therefore leaks at most `MAX_OPEN_TAILS` small cursors for at most this
 *  long. */
const TAIL_IDLE_MS = 5 * 60_000

/** Evicting least-recently-touched on `open` -- bounded memory even if a
 *  renderer opens many tails across many windows and closes none of them. */
const MAX_OPEN_TAILS = 8

interface TailState {
  readonly cursor: TranscriptCursor
  readonly touchedAt: number
}

export interface TailStoreDeps {
  readonly openTranscript: typeof openTranscript
  readonly advanceTranscript: typeof advanceTranscript
  readonly now: () => number
}

const defaultDeps: TailStoreDeps = {
  openTranscript,
  advanceTranscript,
  now: () => Date.now(),
}

export interface OpenTailParams {
  readonly sessionId: string
  readonly agentId: string | null
  readonly claudeHome?: string
}

export interface PollTailParams {
  readonly tailId: string
}

export interface CloseTailParams {
  readonly tailId: string
}

export interface TailStore {
  openTail(params: OpenTailParams): Promise<TranscriptTailOpen>
  pollTail(params: PollTailParams): Promise<TranscriptTailPoll>
  closeTail(params: CloseTailParams): void
  /** Test-only introspection -- how many tails are currently held open. */
  readonly size: number
}

function paramsToOpen(params: OpenTailParams): OpenTranscriptParams {
  return { sessionId: params.sessionId, agentId: params.agentId, claudeHome: params.claudeHome }
}

/** `createTailStore` is a factory, never a shared module-level singleton by
 *  itself, so a test gets its own `Map` and its own injected clock;
 *  `main/ipc.ts` binds the one instance the running app actually uses. */
export function createTailStore(deps: TailStoreDeps = defaultDeps): TailStore {
  const tails = new Map<string, TailState>()
  let nextId = 0

  function sweepIdle(): void {
    const cutoff = deps.now() - TAIL_IDLE_MS
    for (const [id, state] of tails) {
      if (state.touchedAt < cutoff) tails.delete(id)
    }
  }

  function evictOldestIfFull(): void {
    if (tails.size < MAX_OPEN_TAILS) return
    let oldestId: string | null = null
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [id, state] of tails) {
      if (state.touchedAt < oldestAt) {
        oldestAt = state.touchedAt
        oldestId = id
      }
    }
    if (oldestId !== null) tails.delete(oldestId)
  }

  async function openTail(params: OpenTailParams): Promise<TranscriptTailOpen> {
    sweepIdle()
    const { read, cursor } = await deps.openTranscript(paramsToOpen(params))
    if (!read.ok) return { ok: false, kind: read.kind, message: read.message, path: read.path }
    if (cursor === null) {
      // openTranscript's own contract: a successful read always carries a
      // cursor. Guarded rather than cast, so a future drift between the two
      // fails loudly here instead of silently losing follow state.
      throw new Error('openTranscript returned ok: true with no cursor')
    }

    evictOldestIfFull()
    nextId += 1
    const tailId = `tail-${nextId}`
    tails.set(tailId, { cursor, touchedAt: deps.now() })
    return { ok: true, tailId, source: read.source, entries: read.entries }
  }

  async function pollTail(params: PollTailParams): Promise<TranscriptTailPoll> {
    sweepIdle()
    const state = tails.get(params.tailId)
    if (state === undefined) {
      return { ok: false, kind: 'unknown-tail', message: `No open tail for '${params.tailId}'.`, path: null }
    }

    const advanced = await deps.advanceTranscript(state.cursor)
    if (!advanced.ok) {
      // Direction of failure: a stale cursor re-opens, it never goes quiet.
      // Dropping the tail here means a later poll against the same id
      // reports unknown-tail (itself a re-open signal) rather than repeating
      // the same failure forever.
      tails.delete(params.tailId)
      return { ok: false, kind: advanced.kind, message: advanced.message, path: advanced.path }
    }

    tails.set(params.tailId, { cursor: advanced.cursor, touchedAt: deps.now() })
    return { ok: true, source: advanced.source, appended: advanced.appended, patched: advanced.patched, hasMore: advanced.hasMore }
  }

  function closeTail(params: CloseTailParams): void {
    tails.delete(params.tailId)
  }

  return {
    openTail,
    pollTail,
    closeTail,
    get size() {
      return tails.size
    },
  }
}

/** The one instance `main/ipc.ts`'s three tail channels bind to. */
export const tailStore: TailStore = createTailStore()
