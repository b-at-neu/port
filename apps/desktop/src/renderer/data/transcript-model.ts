// Pure transcript state for the one transcript query — revision sequencing, delta and poll folding, and the poll delay. No DOM, no IPC.
import type { LiveBlock, SessionAttachResult, SessionEntriesDelta, SessionHistory, SessionKey } from '@/types/hosting'
import type { EntryPatch, TranscriptEntry, TranscriptFailureKind, TranscriptSource, TranscriptTailFailureKind, TranscriptTailOpen, TranscriptTailPoll } from '@/utils/sessions/transcript'

export type TranscriptTarget = { readonly kind: 'session'; readonly sessionKey: SessionKey } | { readonly kind: 'file'; readonly sessionId: string; readonly agentId: string | null }

export type SessionTarget = Extract<TranscriptTarget, { kind: 'session' }>
export type FileTarget = Extract<TranscriptTarget, { kind: 'file' }>

export interface TailFailure {
  readonly kind: TranscriptTailFailureKind | 'unreachable'
  readonly message: string
  readonly path: string | null
}

export interface SessionReady {
  readonly kind: 'session'
  readonly status: 'ready'
  readonly entries: readonly TranscriptEntry[]
  readonly firstIndex: number
  readonly live: LiveBlock | null
  readonly history: SessionHistory
  readonly revision: number
}

export interface SessionGone {
  readonly kind: 'session'
  readonly status: 'gone'
}

export interface FileReady {
  readonly kind: 'file'
  readonly status: 'ready'
  readonly tailId: string
  readonly source: TranscriptSource
  readonly entries: readonly TranscriptEntry[]
  readonly following: boolean
  readonly failure: TailFailure | null
  readonly truncatedNote: boolean
  readonly hasMore: boolean
}

export interface FileOpenFailed {
  readonly kind: 'file'
  readonly status: 'open-failed'
  readonly failure: { readonly kind: TranscriptFailureKind; readonly message: string; readonly path: string | null }
}

export type SessionTranscript = SessionReady | SessionGone
export type FileTranscript = FileReady | FileOpenFailed
export type TranscriptData = SessionTranscript | FileTranscript

/** TanStack reads an interval of `0` as off, so an immediate catch-up poll waits one millisecond. */
export const CATCH_UP_MS = 1
export const TAIL_INTERVAL_MS = 1000

type SequenceOutcome = 'apply' | 'stale' | 'gap'

interface Revisioned {
  readonly revision: number
}

/** `delta.revision <= lastRevision` is a replay, exactly `lastRevision + 1` applies, anything higher is a gap that must never be applied out of order. */
export function accept(lastRevision: number, delta: Revisioned): SequenceOutcome {
  if (delta.revision <= lastRevision) return 'stale'
  if (delta.revision === lastRevision + 1) return 'apply'
  return 'gap'
}

type DrainResult<T> = { readonly kind: 'apply'; readonly deltas: readonly T[] } | { readonly kind: 'gap' }

/** Folds in the pushes buffered while an attach was in flight: those at or below `attachRevision` are already covered, and a hole in the rest means the caller must re-attach. */
export function drainBuffered<T extends Revisioned>(attachRevision: number, buffered: readonly T[]): DrainResult<T> {
  const relevant = [...buffered].filter((delta) => delta.revision > attachRevision).sort((a, b) => a.revision - b.revision)

  let expected = attachRevision + 1
  const toApply: T[] = []
  for (const delta of relevant) {
    if (delta.revision === expected) {
      toApply.push(delta)
      expected += 1
    } else if (delta.revision > expected) {
      return { kind: 'gap' }
    }
  }
  return { kind: 'apply', deltas: toApply }
}

function patchAt(entries: readonly TranscriptEntry[], firstIndex: number, patches: readonly EntryPatch[]): readonly TranscriptEntry[] {
  const next = [...entries]
  for (const patch of patches) {
    const relative = patch.index - firstIndex
    if (relative >= 0 && relative < next.length) next[relative] = patch.entry
  }
  return next
}

function foldPartial(live: LiveBlock | null, partial: SessionEntriesDelta['partial']): LiveBlock | null {
  if (partial === null) return live
  if (partial.op === 'clear') return null
  if (live !== null && live.blockId === partial.blockId) return { ...live, text: live.text + partial.text }
  return { blockId: partial.blockId, kind: partial.kind, text: partial.text, omittedChars: 0 }
}

type AttachOk = Extract<SessionAttachResult, { ok: true }>

export function applyDelta(data: SessionReady, delta: SessionEntriesDelta): SessionReady {
  const appended = delta.appended.length > 0 ? [...data.entries, ...delta.appended] : data.entries
  return { ...data, entries: patchAt(appended, data.firstIndex, delta.patched), live: foldPartial(data.live, delta.partial), revision: delta.revision }
}

export function fromAttach(result: AttachOk, deltas: readonly SessionEntriesDelta[]): SessionReady {
  const attached: SessionReady = { kind: 'session', status: 'ready', entries: result.entries, firstIndex: result.firstIndex, live: result.partial, history: result.history, revision: result.revision }
  return deltas.reduce(applyDelta, attached)
}

type OpenOk = Extract<TranscriptTailOpen, { ok: true }>
type PollOk = Extract<TranscriptTailPoll, { ok: true }>

export function fromOpen(opened: OpenOk, truncatedNote: boolean): FileReady {
  return { kind: 'file', status: 'ready', tailId: opened.tailId, source: opened.source, entries: opened.entries, following: true, failure: null, truncatedNote, hasMore: false }
}

export function applyPoll(data: FileReady, polled: PollOk): FileReady {
  const patched = [...data.entries]
  for (const patch of polled.patched) if (patch.index >= 0 && patch.index < patched.length) patched[patch.index] = patch.entry
  return { ...data, source: polled.source, entries: [...patched, ...polled.appended], failure: null, truncatedNote: false, hasMore: polled.hasMore }
}

export function pollFailed(data: FileReady, failure: TailFailure): FileReady {
  return { ...data, following: false, failure }
}

export function setFollowing(data: FileReady, following: boolean): FileReady {
  return following ? { ...data, following, failure: null } : { ...data, following }
}

/** `false` stops the poll timer: a paused tail, a failed open, and every session. */
export function pollDelay(data: TranscriptData | undefined): number | false {
  if (data === undefined || data.kind !== 'file' || data.status !== 'ready' || !data.following) return false
  return data.hasMore ? CATCH_UP_MS : TAIL_INTERVAL_MS
}
