// Owns the transcript tail's open/poll/close cycle and the follow toggle.
// `createTailStore` is the injectable, directly-testable factory.
import { useCallback, useSyncExternalStore } from 'react'
import { invoke } from '../data/invoke'
import type { EntryPatch, TranscriptEntry, TranscriptSource, TranscriptTailOpen, TranscriptTailPoll } from '../../../shared/sessions/transcript'
import { openFailureCopy, tailBannerKindFor } from './copy'
import type { TailBannerKind } from './copy'

export interface TailBanner {
  readonly kind: TailBannerKind
  readonly message: string
  readonly path: string | null
}

export type TailSnapshot =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'unreachable' }
  | {
      readonly status: 'ready'
      readonly source: TranscriptSource
      readonly entries: readonly TranscriptEntry[]
      readonly following: boolean
      readonly banner: TailBanner | null
      readonly truncatedNote: boolean
    }

const LOADING: TailSnapshot = { status: 'loading' }
const TAIL_INTERVAL_MS = 1000

function patchEntries(entries: readonly TranscriptEntry[], patches: readonly EntryPatch[]): readonly TranscriptEntry[] {
  if (patches.length === 0) return entries
  const next = [...entries]
  for (const patch of patches) if (patch.index >= 0 && patch.index < next.length) next[patch.index] = patch.entry
  return next
}

export interface TailStoreDeps {
  readonly tailOpen: (sessionId: string, agentId: string | null) => Promise<TranscriptTailOpen>
  readonly tailPoll: (tailId: string) => Promise<TranscriptTailPoll>
  readonly tailClose: (tailId: string) => Promise<unknown>
  readonly isHidden: () => boolean
  readonly onVisibilityChange: (listener: () => void) => () => void
}

export interface TailStore {
  subscribe(sessionId: string, agentId: string | null, listener: () => void): () => void
  getSnapshot(): TailSnapshot
  toggleFollow(): void
  retry(): void
}

/** Injectable so `tail-store.test.ts` can drive supersede/visibility/close
 *  with fakes — no real IPC, no timers, no real `document`. */
export function createTailStore(deps: TailStoreDeps): TailStore {
  let target: { readonly sessionId: string; readonly agentId: string | null } | null = null
  let tailId: string | null = null
  let following = true
  let timer: ReturnType<typeof setTimeout> | null = null
  let snapshot: TailSnapshot = LOADING
  const listeners = new Set<() => void>()
  let visibilityAttached = false

  function notify(): void {
    for (const listener of listeners) listener()
  }

  function stopTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function scheduleNext(delayMs: number): void {
    if (tailId === null || !following || deps.isHidden()) return
    const id = tailId
    timer = setTimeout(() => void poll(id), delayMs)
  }

  async function poll(id: string, noteTruncation = false): Promise<void> {
    if (tailId !== id) return
    try {
      const polled = await deps.tailPoll(id)
      if (tailId !== id) return
      if (!polled.ok) {
        if (polled.kind === 'unknown-tail' || polled.kind === 'truncated') {
          await reopen(polled.kind === 'truncated')
          return
        }
        following = false
        if (snapshot.status === 'ready') snapshot = { ...snapshot, following: false, banner: { kind: tailBannerKindFor(polled.kind), message: polled.message, path: polled.path } }
        notify()
        return
      }
      if (snapshot.status === 'ready') {
        snapshot = { ...snapshot, source: polled.source, entries: [...patchEntries(snapshot.entries, polled.patched), ...polled.appended], banner: null, truncatedNote: noteTruncation }
      }
      notify()
      scheduleNext(polled.hasMore ? 0 : TAIL_INTERVAL_MS)
    } catch (error) {
      console.error('Failed to poll a transcript tail', error)
      following = false
      if (snapshot.status === 'ready') snapshot = { ...snapshot, following: false, banner: { kind: 'unreachable', message: 'Lost contact with the main process.', path: null } }
      notify()
    }
  }

  async function reopen(noteTruncation: boolean): Promise<void> {
    if (target === null) return
    await open(target.sessionId, target.agentId, noteTruncation)
  }

  async function open(sessionId: string, agentId: string | null, noteTruncation = false): Promise<void> {
    target = { sessionId, agentId }
    following = true
    snapshot = LOADING
    notify()
    try {
      const opened = await deps.tailOpen(sessionId, agentId)
      if (target?.sessionId !== sessionId || target.agentId !== agentId) return
      if (!opened.ok) {
        tailId = null
        snapshot = { status: 'error', message: openFailureCopy(opened.kind, opened.message, opened.path) }
        notify()
        return
      }
      tailId = opened.tailId
      snapshot = { status: 'ready', source: opened.source, entries: opened.entries, following: true, banner: null, truncatedNote: noteTruncation }
      notify()
      scheduleNext(TAIL_INTERVAL_MS)
    } catch (error) {
      console.error('Failed to open a transcript tail', error)
      tailId = null
      snapshot = { status: 'unreachable' }
      notify()
    }
  }

  function close(): void {
    stopTimer()
    target = null
    const id = tailId
    tailId = null
    if (id !== null) {
      deps.tailClose(id).catch((error: unknown) => {
        console.error('Failed to close a transcript tail', error)
      })
    }
  }

  function ensureVisibilityAttached(): void {
    if (visibilityAttached) return
    visibilityAttached = true
    deps.onVisibilityChange(() => {
      if (tailId === null) return
      if (deps.isHidden()) stopTimer()
      else if (following) void poll(tailId)
    })
  }

  return {
    getSnapshot: () => snapshot,
    toggleFollow() {
      if (tailId === null) return
      following = !following
      if (following) {
        if (snapshot.status === 'ready') snapshot = { ...snapshot, following: true, banner: null }
        notify()
        void poll(tailId)
      } else {
        stopTimer()
        if (snapshot.status === 'ready') snapshot = { ...snapshot, following: false }
        notify()
      }
    },
    retry() {
      if (tailId === null) return
      following = true
      if (snapshot.status === 'ready') snapshot = { ...snapshot, following: true, banner: null }
      notify()
      void poll(tailId)
    },
    subscribe(sessionId, agentId, listener) {
      ensureVisibilityAttached()
      listeners.add(listener)
      if (target?.sessionId !== sessionId || target.agentId !== agentId) void open(sessionId, agentId)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) close()
      }
    },
  }
}

let shared: TailStore | null = null

function sharedStore(): TailStore {
  shared ??= createTailStore({
    tailOpen: (sessionId, agentId) => invoke('transcript:tail:open', { sessionId, agentId }),
    tailPoll: (tailId) => invoke('transcript:tail:poll', { tailId }),
    tailClose: (tailId) => invoke('transcript:tail:close', { tailId }),
    isHidden: () => document.hidden,
    onVisibilityChange: (listener) => {
      document.addEventListener('visibilitychange', listener)
      return () => document.removeEventListener('visibilitychange', listener)
    },
  })
  return shared
}

export function toggleFollow(): void {
  sharedStore().toggleFollow()
}

export function retryTail(): void {
  sharedStore().retry()
}

export function useTranscriptTail(sessionId: string, agentId: string | null): TailSnapshot {
  const store = sharedStore()
  const subscribe = useCallback((listener: () => void) => store.subscribe(sessionId, agentId, listener), [store, sessionId, agentId])
  const getSnapshot = useCallback(() => store.getSnapshot(), [store])

  return useSyncExternalStore(subscribe, getSnapshot)
}
