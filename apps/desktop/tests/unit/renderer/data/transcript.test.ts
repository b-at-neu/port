import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryObserver } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { createQueryClient } from '@/renderer/data/query'
import type { invoke } from '@/renderer/data/invoke'
import { connectTranscriptCache, transcriptKey, transcriptQueryOptions } from '@/renderer/data/transcript'
import type { FileTarget, SessionTarget, TranscriptData } from '@/renderer/data/transcript-model'
import type { SessionEntriesDelta, SessionKey } from '@/types/hosting'
import type { Subscriptions } from '@/types/data'
import type { TranscriptEntry } from '@/utils/sessions/transcript'

const SESSION: SessionTarget = { kind: 'session', sessionKey: 'hosted-1' as SessionKey }
const FILE: FileTarget = { kind: 'file', sessionId: 's1', agentId: null }

const meta = (uuid: string): TranscriptEntry => ({ type: 'meta', uuid, timestamp: '2026-01-01T00:00:00Z', label: uuid })
const source = { sessionId: 's1', agentId: null, path: '/p', sizeBytes: 1, modifiedAt: '2026-01-01T00:00:00Z', recordCount: 0, malformedLines: 0 }

const attached = (revision: number, entries: readonly TranscriptEntry[] = []) => ({ ok: true, snapshot: {}, replay: [], droppedBefore: 0, entries, firstIndex: 0, partial: null, pendingSends: [], revision, history: { kind: 'none' } })
const opened = (tailId: string) => ({ ok: true, tailId, source, entries: [meta('a')] })
const delta = (revision: number, appended: readonly TranscriptEntry[]): SessionEntriesDelta => ({ sessionKey: SESSION.sessionKey, revision, appended, patched: [], partial: null, pendingSends: null })

type Handler = (input: unknown) => unknown

function stubInvoke(handlers: Readonly<Record<string, Handler>>) {
  const calls: string[] = []
  const stub = (name: string, input?: unknown) => {
    calls.push(name)
    return Promise.resolve(handlers[name]?.(input))
  }
  return { invoke: stub as unknown as typeof invoke, calls }
}

function fakeSubscriptions() {
  const listeners = new Set<(delta: SessionEntriesDelta) => void>()
  const subscriptions = {
    subscribe: (_event: string, listener: (delta: SessionEntriesDelta) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as Subscriptions
  return {
    subscriptions,
    push: (pushed: SessionEntriesDelta) => {
      for (const listener of listeners) listener(pushed)
    },
  }
}

let client: QueryClient
const cleanups: (() => void)[] = []

function observe(target: SessionTarget | FileTarget, invokeStub: typeof invoke): QueryObserver<TranscriptData> {
  const observer = new QueryObserver(client, transcriptQueryOptions(target, { invoke: invokeStub, client })) as unknown as QueryObserver<TranscriptData>
  cleanups.push(observer.subscribe(() => undefined))
  return observer
}

const dataOf = (target: SessionTarget | FileTarget) => client.getQueryData<TranscriptData>(transcriptKey(target))

beforeEach(() => {
  client = createQueryClient()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  client.clear()
  vi.restoreAllMocks()
})

describe('session transcript', () => {
  it('folds in a push that lands while the attach is in flight', async () => {
    let release: (value: unknown) => void = () => undefined
    const gate = new Promise((resolve) => (release = resolve))
    const { invoke: stub, calls } = stubInvoke({ 'session.attach': () => gate.then(() => attached(1, [meta('a')])) })
    const { subscriptions, push } = fakeSubscriptions()
    cleanups.push(connectTranscriptCache(client, subscriptions, stub))

    observe(SESSION, stub)
    await vi.waitFor(() => expect(calls).toEqual(['session.attach']))
    push(delta(2, [meta('b')]))
    release(undefined)

    await vi.waitFor(() => expect(dataOf(SESSION)).toMatchObject({ status: 'ready', revision: 2 }))
    expect(dataOf(SESSION)).toMatchObject({ entries: [{ uuid: 'a' }, { uuid: 'b' }] })
  })

  it('re-attaches when a push skips a revision', async () => {
    let revision = 1
    const { invoke: stub, calls } = stubInvoke({ 'session.attach': () => attached(revision) })
    const { subscriptions, push } = fakeSubscriptions()
    cleanups.push(connectTranscriptCache(client, subscriptions, stub))

    observe(SESSION, stub)
    await vi.waitFor(() => expect(dataOf(SESSION)).toMatchObject({ revision: 1 }))
    revision = 3
    push(delta(3, [meta('c')]))

    await vi.waitFor(() => expect(dataOf(SESSION)).toMatchObject({ revision: 3 }))
    expect(calls.filter((name) => name === 'session.attach')).toHaveLength(2)
  })

  it('reports a session the main process no longer has as gone', async () => {
    const { invoke: stub } = stubInvoke({ 'session.attach': () => ({ ok: false, kind: 'unknown-session' }) })
    observe(SESSION, stub)

    await vi.waitFor(() => expect(dataOf(SESSION)).toEqual({ kind: 'session', status: 'gone' }))
  })
})

describe('file transcript', () => {
  it('closes the tail once its query is removed', async () => {
    const closed: unknown[] = []
    const { invoke: stub } = stubInvoke({ 'transcript.tailOpen': () => opened('t1'), 'transcript.tailClose': (input) => closed.push(input) })
    const { subscriptions } = fakeSubscriptions()
    cleanups.push(connectTranscriptCache(client, subscriptions, stub))

    observe(FILE, stub)
    await vi.waitFor(() => expect(dataOf(FILE)).toMatchObject({ status: 'ready', tailId: 't1' }))
    cleanups.pop()?.()

    await vi.waitFor(() => expect(closed).toEqual([{ tailId: 't1' }]))
  })

  it('reopens when the main process has lost the tail', async () => {
    let opens = 0
    const { invoke: stub } = stubInvoke({
      'transcript.tailOpen': () => opened(opens++ === 0 ? 'old' : 'new'),
      'transcript.tailPoll': () => ({ ok: false, kind: 'unknown-tail', message: '', path: null }),
    })
    const observer = observe(FILE, stub)
    await vi.waitFor(() => expect(dataOf(FILE)).toMatchObject({ tailId: 'old' }))

    await observer.refetch()

    expect(dataOf(FILE)).toMatchObject({ status: 'ready', tailId: 'new', truncatedNote: false })
  })

  it('notes a rewritten transcript when it reopens', async () => {
    let opens = 0
    const { invoke: stub } = stubInvoke({
      'transcript.tailOpen': () => opened(opens++ === 0 ? 'old' : 'new'),
      'transcript.tailPoll': () => ({ ok: false, kind: 'truncated', message: '', path: null }),
    })
    const observer = observe(FILE, stub)
    await vi.waitFor(() => expect(dataOf(FILE)).toMatchObject({ tailId: 'old' }))

    await observer.refetch()

    expect(dataOf(FILE)).toMatchObject({ tailId: 'new', truncatedNote: true })
  })

  it('keeps the entries and stops following when a poll cannot reach the main process', async () => {
    const { invoke: stub } = stubInvoke({
      'transcript.tailOpen': () => opened('t1'),
      'transcript.tailPoll': () => {
        throw new Error('gone')
      },
    })
    const observer = observe(FILE, stub)
    await vi.waitFor(() => expect(dataOf(FILE)).toMatchObject({ status: 'ready' }))

    await observer.refetch()

    expect(dataOf(FILE)).toMatchObject({ following: false, failure: { kind: 'unreachable' }, entries: [{ uuid: 'a' }] })
  })

  it('reports a failed open as data, not an error', async () => {
    const { invoke: stub } = stubInvoke({ 'transcript.tailOpen': () => ({ ok: false, kind: 'not-found', message: 'x', path: '/p' }) })
    observe(FILE, stub)

    await vi.waitFor(() => expect(dataOf(FILE)).toMatchObject({ status: 'open-failed', failure: { kind: 'not-found' } }))
  })
})
