import { describe, expect, it, vi } from 'vitest'
import { createHostedHandle, REPLAY_LIMIT } from './handle'
import type { HostedQuery } from './handle'
import type { SessionEventEnvelope, SessionKey } from '../../shared/hosting/types'
import type { RepoId } from '../../shared/repos'

const SESSION_KEY = 'hosted-1' as SessionKey
const REPO_ID = 'repo-1' as RepoId

/** A fake `HostedQuery` driven entirely from the test — `push` delivers the
 *  next message to whichever `next()` is currently waiting, `end`/`fail`
 *  finish the generator, and `interrupt`/`close` are spies the assertions
 *  read back. */
function fakeQuery() {
  let pendingResolve: ((result: IteratorResult<unknown>) => void) | null = null
  let pendingReject: ((error: Error) => void) | null = null
  const queue: unknown[] = []
  let done = false
  let failure: Error | null = null

  const interrupt = vi.fn((): Promise<{ still_queued: string[] } | undefined> => Promise.resolve({ still_queued: ['a', 'b'] }))
  const close = vi.fn()

  const query: HostedQuery = {
    interrupt,
    close,
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<unknown>> {
          if (queue.length > 0) return Promise.resolve({ done: false, value: queue.shift() })
          if (failure !== null) return Promise.reject(failure)
          if (done) return Promise.resolve({ done: true, value: undefined })
          return new Promise((resolve, reject) => {
            pendingResolve = resolve
            pendingReject = reject
          })
        },
      }
    },
  } as unknown as HostedQuery

  return {
    query,
    interrupt,
    close,
    push(message: unknown) {
      if (pendingResolve) {
        const resolve = pendingResolve
        pendingResolve = null
        pendingReject = null
        resolve({ done: false, value: message })
      } else {
        queue.push(message)
      }
    },
    finish() {
      done = true
      if (pendingResolve) {
        const resolve = pendingResolve
        pendingResolve = null
        pendingReject = null
        resolve({ done: true, value: undefined })
      }
    },
    fail(error: Error) {
      failure = error
      if (pendingReject) {
        const reject = pendingReject
        pendingResolve = null
        pendingReject = null
        reject(error)
      }
    },
  }
}

function baseParams(overrides: Partial<Parameters<typeof createHostedHandle>[0]> = {}) {
  return {
    sessionKey: SESSION_KEY,
    repoId: REPO_ID,
    mode: { kind: 'fresh' as const },
    cwd: '/repo',
    executablePath: '/usr/local/bin/claude',
    credentials: null,
    now: () => 1_000,
    onEvent: vi.fn(),
    onStatus: vi.fn(),
    ...overrides,
  }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('createHostedHandle', () => {
  it('starts in the starting phase and moves to ready on init, adopting claudeSessionId', async () => {
    const fake = fakeQuery()
    const onSessionId = vi.fn()
    const handle = createHostedHandle(baseParams({ onSessionId }), () => fake.query)
    expect(handle.snapshot().phase).toBe('starting')
    expect(handle.snapshot().claudeSessionId).toBeNull()

    fake.push({ type: 'system', subtype: 'init', session_id: 'sdk-session-1' })
    await flush()

    expect(handle.snapshot().phase).toBe('ready')
    expect(handle.snapshot().claudeSessionId).toBe('sdk-session-1')
    expect(onSessionId).toHaveBeenCalledWith('sdk-session-1')
    expect(onSessionId).toHaveBeenCalledTimes(1)
  })

  it('a second init never re-fires onSessionId', async () => {
    const fake = fakeQuery()
    const onSessionId = vi.fn()
    createHostedHandle(baseParams({ onSessionId }), () => fake.query)
    fake.push({ type: 'system', subtype: 'init', session_id: 'sdk-session-1' })
    await flush()
    fake.push({ type: 'system', subtype: 'init', session_id: 'sdk-session-1' })
    await flush()
    expect(onSessionId).toHaveBeenCalledTimes(1)
  })

  it('a user message moves ready to streaming, and a result moves it back to ready', async () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams(), () => fake.query)
    fake.push({ type: 'system', subtype: 'init', session_id: 'sdk-session-1' })
    await flush()
    expect(handle.snapshot().phase).toBe('ready')

    fake.push({ type: 'user', message: { role: 'user', content: 'hi' } })
    await flush()
    expect(handle.snapshot().phase).toBe('streaming')

    fake.push({ type: 'result', subtype: 'success' })
    await flush()
    expect(handle.snapshot().phase).toBe('ready')
  })

  it('every pushed message is forwarded to onEvent with a monotonic seq', async () => {
    const onEvent = vi.fn((envelope: SessionEventEnvelope): void => {
      void envelope
    })
    const fake = fakeQuery()
    createHostedHandle(baseParams({ onEvent }), () => fake.query)
    fake.push({ type: 'system', subtype: 'init', session_id: 'x' })
    await flush()
    fake.push({ type: 'result', subtype: 'success' })
    await flush()
    expect(onEvent).toHaveBeenCalledTimes(2)
    const [firstCall, secondCall] = onEvent.mock.calls
    expect(firstCall?.[0]?.seq).toBe(1)
    expect(secondCall?.[0]?.seq).toBe(2)
  })

  it('a generator that completes normally ends with reason completed', async () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams(), () => fake.query)
    fake.finish()
    await flush()
    expect(handle.snapshot().phase).toBe('ended')
    expect(handle.snapshot().end).toEqual({ reason: 'completed', exitCode: null, signal: null, message: null, diagnosis: null })
  })

  it('a generator that throws is classified through classifyEnd, message carried verbatim', async () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams(), () => fake.query)
    fake.fail(new Error('Claude Code process exited with code 1'))
    await flush()
    const end = handle.snapshot().end
    expect(end?.reason).toBe('exit-nonzero')
    expect(end?.exitCode).toBe(1)
    expect(end?.message).toBe('Claude Code process exited with code 1')
  })

  it('send() always accepts and returns a uuid, never refusing mid-turn', () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams(), () => fake.query)
    const result = handle.send('do the thing')
    expect(result.queued).toBe(true)
    expect(result.uuid.length).toBeGreaterThan(0)
  })

  it('interrupt() moves to interrupting, then records still_queued.length from the receipt', async () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams(), () => fake.query)
    const pending = handle.interrupt()
    expect(handle.snapshot().phase).toBe('interrupting')
    const queuedAfterInterrupt = await pending
    expect(queuedAfterInterrupt).toBe(2)
    expect(handle.snapshot().queuedAfterInterrupt).toBe(2)
    expect(fake.interrupt).toHaveBeenCalledTimes(1)
  })

  it('interrupt() reports null, never zero, when the CLI returns no receipt', async () => {
    const fake = fakeQuery()
    fake.interrupt.mockResolvedValueOnce(undefined)
    const handle = createHostedHandle(baseParams(), () => fake.query)
    const queuedAfterInterrupt = await handle.interrupt()
    expect(queuedAfterInterrupt).toBeNull()
  })

  it('close() ends the input iterator, waits for the generator, then forces query.close()', async () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams(), () => fake.query)
    const closePromise = handle.close()
    expect(handle.snapshot().phase).toBe('closing')
    fake.finish()
    await closePromise
    expect(fake.close).toHaveBeenCalledTimes(1)
    expect(handle.snapshot().phase).toBe('ended')
    expect(handle.snapshot().end?.reason).toBe('completed')
  })

  it('close() classifies an "aborted by user" ending it asked for as closed, not stream-error', async () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams(), () => fake.query)
    const closePromise = handle.close()
    fake.fail(new Error('Claude Code process aborted by user'))
    await closePromise
    expect(handle.snapshot().end?.reason).toBe('closed')
  })

  it('setTitled() is reflected on the next snapshot', () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams(), () => fake.query)
    expect(handle.snapshot().titled).toBeNull()
    handle.setTitled(false)
    expect(handle.snapshot().titled).toBe(false)
  })

  it('the replay ring never grows past REPLAY_LIMIT, and reports what it dropped', async () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams(), () => fake.query)
    const total = REPLAY_LIMIT + 3
    for (let i = 0; i < total; i += 1) fake.push({ type: 'result', subtype: 'success', n: i })
    // A macrotask boundary rather than a fixed number of microtask flushes —
    // draining `total` queued messages through the pump's own `await` per
    // iteration takes as many microtask turns as there are messages, and
    // `setTimeout` only runs once every pending microtask has settled.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const { events, droppedBefore } = handle.replay()
    expect(events.length).toBe(REPLAY_LIMIT)
    expect(droppedBefore).toBe(3)
    expect(events[0]?.seq).toBe(4)
    expect(events[events.length - 1]?.seq).toBe(total)
  })

  it('origin reflects the start mode: fresh, resumed, and forked', () => {
    const fresh = createHostedHandle(baseParams({ mode: { kind: 'fresh' } }), () => fakeQuery().query)
    expect(fresh.snapshot().origin).toEqual({ kind: 'fresh' })

    const resumed = createHostedHandle(baseParams({ mode: { kind: 'resume', sessionId: 'parent' } }), () => fakeQuery().query)
    expect(resumed.snapshot().origin).toEqual({ kind: 'resumed', from: 'parent' })

    const forked = createHostedHandle(baseParams({ mode: { kind: 'fork', sessionId: 'parent' } }), () => fakeQuery().query)
    expect(forked.snapshot().origin).toEqual({ kind: 'forked', from: 'parent', atMessageUuid: null })
  })
})
