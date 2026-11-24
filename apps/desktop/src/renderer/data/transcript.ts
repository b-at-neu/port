// The one transcript query: a hosted session read by attach and kept live by pushes, or a transcript file read by tail open and polled until its query is removed.
import { useQuery, useQueryClient, queryOptions } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import type { SessionEntriesDelta, SessionKey } from '@/types/hosting'
import type { Subscriptions } from '@/types/data'
import { invoke as defaultInvoke } from '@/renderer/data/invoke'
import { accept, applyDelta, applyPoll, drainBuffered, fromAttach, fromOpen, pollDelay, pollFailed, setFollowing } from '@/renderer/data/transcript-model'
import type { FileOpenFailed, FileReady, FileTarget, FileTranscript, SessionGone, SessionTarget, SessionTranscript, TranscriptData, TranscriptTarget } from '@/renderer/data/transcript-model'

type Invoke = typeof defaultInvoke

interface TranscriptDeps {
  readonly invoke: Invoke
  readonly client: QueryClient
}

const MAX_ATTACH_ATTEMPTS = 5

const inFlight = new Map<SessionKey, SessionEntriesDelta[]>()

export function transcriptKey(target: TranscriptTarget) {
  return ['transcript', target] as const
}

async function fetchSession(target: SessionTarget, invoke: Invoke): Promise<SessionTranscript> {
  const buffer: SessionEntriesDelta[] = []
  inFlight.set(target.sessionKey, buffer)
  try {
    for (let attempt = 1; ; attempt += 1) {
      const result = await invoke('session.attach', { sessionKey: target.sessionKey })
      if (!result.ok) return { kind: 'session', status: 'gone' } satisfies SessionGone
      const drained = drainBuffered(result.revision, buffer.splice(0))
      if (drained.kind === 'apply') return fromAttach(result, drained.deltas)
      if (attempt === MAX_ATTACH_ATTEMPTS) return fromAttach(result, [])
    }
  } finally {
    if (inFlight.get(target.sessionKey) === buffer) inFlight.delete(target.sessionKey)
  }
}

async function openTail(target: FileTarget, invoke: Invoke, signal: AbortSignal, truncatedNote: boolean): Promise<FileTranscript> {
  const opened = await invoke('transcript.tailOpen', { sessionId: target.sessionId, agentId: target.agentId })
  if (!opened.ok) return { kind: 'file', status: 'open-failed', failure: { kind: opened.kind, message: opened.message, path: opened.path } } satisfies FileOpenFailed
  if (signal.aborted) closeTail(opened.tailId, invoke)
  return fromOpen(opened, truncatedNote)
}

function closeTail(tailId: string, invoke: Invoke): void {
  invoke('transcript.tailClose', { tailId }).catch((error: unknown) => {
    console.error('Failed to close a transcript tail', error)
  })
}

async function pollTail(target: FileTarget, started: FileReady, deps: TranscriptDeps, signal: AbortSignal): Promise<FileTranscript> {
  const latest = (): FileReady => {
    const current = deps.client.getQueryData<FileTranscript>(transcriptKey(target))
    return current?.status === 'ready' ? current : started
  }
  let polled
  try {
    polled = await deps.invoke('transcript.tailPoll', { tailId: started.tailId })
  } catch (error) {
    console.error('Failed to poll a transcript tail', error)
    return pollFailed(latest(), { kind: 'unreachable', message: 'Lost contact with the main process.', path: null })
  }
  if (polled.ok) return applyPoll(latest(), polled)
  if (polled.kind === 'unknown-tail' || polled.kind === 'truncated') return openTail(target, deps.invoke, signal, polled.kind === 'truncated')
  return pollFailed(latest(), { kind: polled.kind, message: polled.message, path: polled.path })
}

async function fetchFile(target: FileTarget, deps: TranscriptDeps, signal: AbortSignal): Promise<FileTranscript> {
  const previous = deps.client.getQueryData<FileTranscript>(transcriptKey(target))
  if (previous?.status === 'ready') return pollTail(target, previous, deps, signal)
  return openTail(target, deps.invoke, signal, false)
}

/** A session stays cached until it is dismissed; a file's query is removed on leaving the screen, which closes its tail. */
export function transcriptQueryOptions(target: TranscriptTarget, deps: TranscriptDeps) {
  return queryOptions({
    queryKey: transcriptKey(target),
    queryFn: ({ signal }): Promise<TranscriptData> => (target.kind === 'session' ? fetchSession(target, deps.invoke) : fetchFile(target, deps, signal)),
    staleTime: Infinity,
    gcTime: target.kind === 'session' ? Infinity : 0,
    refetchInterval: (query) => pollDelay(query.state.data),
  })
}

function tailIdOf(query: { readonly queryKey: readonly unknown[]; readonly state: { readonly data: unknown } }): string | null {
  const [root, target] = query.queryKey as readonly [unknown, TranscriptTarget | undefined]
  const data = query.state.data as TranscriptData | undefined
  if (root !== 'transcript' || target?.kind !== 'file' || data?.kind !== 'file' || data.status !== 'ready') return null
  return data.tailId
}

/** Folds `session.entries` pushes into the cache and closes a file tail when its query is removed. */
export function connectTranscriptCache(client: QueryClient, subscriptions: Subscriptions, invoke: Invoke = defaultInvoke): () => void {
  const detachPush = subscriptions.subscribe('session.entries', (delta: SessionEntriesDelta) => {
    const buffer = inFlight.get(delta.sessionKey)
    if (buffer !== undefined) {
      buffer.push(delta)
      return
    }
    const key = transcriptKey({ kind: 'session', sessionKey: delta.sessionKey })
    const data = client.getQueryData<SessionTranscript>(key)
    if (data?.status !== 'ready') return
    const outcome = accept(data.revision, delta)
    if (outcome === 'apply') client.setQueryData<SessionTranscript>(key, applyDelta(data, delta))
    else if (outcome === 'gap') void client.invalidateQueries({ queryKey: key })
  })
  const detachRemoval = client.getQueryCache().subscribe((event) => {
    if (event.type !== 'removed') return
    const tailId = tailIdOf(event.query)
    if (tailId !== null) closeTail(tailId, invoke)
  })
  return () => {
    detachPush()
    detachRemoval()
  }
}

export function forgetTranscript(client: QueryClient, target: TranscriptTarget): void {
  client.removeQueries({ queryKey: transcriptKey(target) })
}

type TranscriptView<D> = { readonly status: 'loading' } | { readonly status: 'unreachable' } | D

interface TranscriptHandle<D> {
  readonly view: TranscriptView<D>
  readonly toggleFollow: () => void
  readonly retry: () => void
}

export function useTranscript(target: SessionTarget): TranscriptHandle<SessionTranscript>
export function useTranscript(target: FileTarget): TranscriptHandle<FileTranscript>
export function useTranscript(target: TranscriptTarget): TranscriptHandle<TranscriptData> {
  const client = useQueryClient()
  const query = useQuery(transcriptQueryOptions(target, { invoke: defaultInvoke, client }))
  const key = transcriptKey(target)

  function readyFile(): FileReady | null {
    const data = client.getQueryData<TranscriptData>(key)
    return data?.kind === 'file' && data.status === 'ready' ? data : null
  }

  function toggleFollow(): void {
    const data = readyFile()
    if (data === null) return
    const next = setFollowing(data, !data.following)
    client.setQueryData<TranscriptData>(key, next)
    if (next.following) void query.refetch()
  }

  function retry(): void {
    const data = readyFile()
    if (data !== null) client.setQueryData<TranscriptData>(key, setFollowing(data, true))
    void query.refetch()
  }

  const view: TranscriptView<TranscriptData> = query.data ?? (query.status === 'error' ? { status: 'unreachable' } : { status: 'loading' })
  return { view, toggleFollow, retry }
}
