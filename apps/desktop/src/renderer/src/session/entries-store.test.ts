import { describe, expect, it, vi } from 'vitest'
import { createEntriesRegistry } from './entries-store'
import type { SessionAttachResult, SessionEntriesDelta, SessionKey } from '../../../shared/hosting/types'
import type { TranscriptEntry } from '../../../shared/sessions/transcript'

const KEY = 'hosted-1' as SessionKey

function entry(uuid: string): TranscriptEntry {
  return { type: 'user-text', uuid, timestamp: 't', text: { text: uuid, omittedChars: 0 } }
}

function okResult(entries: readonly TranscriptEntry[], revision: number): Extract<SessionAttachResult, { readonly ok: true }> {
  return {
    ok: true,
    snapshot: {} as Extract<SessionAttachResult, { readonly ok: true }>['snapshot'],
    replay: [],
    droppedBefore: 0,
    entries,
    firstIndex: 0,
    partial: null,
    pendingSends: [],
    revision,
  }
}

function delta(partial: Partial<SessionEntriesDelta> & { readonly revision: number }): SessionEntriesDelta {
  return { sessionKey: KEY, appended: [], patched: [], partial: null, pendingSends: null, ...partial }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('createEntriesRegistry', () => {
  it('attaches on first subscribe and applies an in-order push', async () => {
    const sessionAttach = vi.fn().mockResolvedValue(okResult([entry('a')], 1))
    const registry = createEntriesRegistry({ sessionAttach })
    registry.subscribe(KEY, () => {})
    await flush()

    expect(sessionAttach).toHaveBeenCalledTimes(1)
    expect(registry.getSnapshot(KEY).entries).toEqual([entry('a')])
    expect(registry.getSnapshot(KEY).attaching).toBe(false)

    registry.handlePush(delta({ revision: 2, appended: [entry('b')] }))
    expect(registry.getSnapshot(KEY).entries).toEqual([entry('a'), entry('b')])
  })

  it('buffers a push that arrives mid-attach, then drains it once attach resolves', async () => {
    let resolveAttach: (result: SessionAttachResult) => void = () => {}
    const sessionAttach = vi.fn().mockReturnValue(new Promise<SessionAttachResult>((resolve) => (resolveAttach = resolve)))
    const registry = createEntriesRegistry({ sessionAttach })
    registry.subscribe(KEY, () => {})

    // Arrives while the attach above is still in flight.
    registry.handlePush(delta({ revision: 2, appended: [entry('buffered')] }))
    expect(registry.getSnapshot(KEY).entries).toEqual([])

    resolveAttach(okResult([entry('a')], 1))
    await flush()

    expect(registry.getSnapshot(KEY).entries).toEqual([entry('a'), entry('buffered')])
  })

  it('re-attaches on a gap instead of applying out of order', async () => {
    const sessionAttach = vi.fn().mockResolvedValue(okResult([entry('a')], 1))
    const registry = createEntriesRegistry({ sessionAttach })
    registry.subscribe(KEY, () => {})
    await flush()

    registry.handlePush(delta({ revision: 5, appended: [entry('skipped-ahead')] }))
    await flush()

    expect(sessionAttach).toHaveBeenCalledTimes(2)
    expect(registry.getSnapshot(KEY).entries).toEqual([entry('a')])
  })

  it('retries internally when draining a buffered push still leaves a gap', async () => {
    let resolveFirst: (result: SessionAttachResult) => void = () => {}
    const sessionAttach = vi
      .fn()
      .mockReturnValueOnce(new Promise<SessionAttachResult>((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce(okResult([entry('a'), entry('b')], 5))
    const registry = createEntriesRegistry({ sessionAttach })
    registry.subscribe(KEY, () => {}) // the first attach starts, still pending

    registry.handlePush(delta({ revision: 5, appended: [entry('far')] })) // buffered — attaching is true
    resolveFirst(okResult([entry('a')], 1)) // drainBuffered(1, [rev 5]) is a gap -> one more attempt, same reattach() call
    await flush()

    expect(sessionAttach).toHaveBeenCalledTimes(2)
    expect(registry.getSnapshot(KEY).entries).toEqual([entry('a'), entry('b')])
    expect(registry.getSnapshot(KEY).attaching).toBe(false)
  })

  it('supersedes an older in-flight attach — only the latest generation\'s result is kept', async () => {
    let resolveFirst: (result: SessionAttachResult) => void = () => {}
    const sessionAttach = vi
      .fn()
      .mockReturnValueOnce(new Promise<SessionAttachResult>((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce(okResult([entry('second')], 1))
    const registry = createEntriesRegistry({ sessionAttach })

    void registry.reattach(KEY)
    void registry.reattach(KEY) // supersedes the call above before it resolves
    await flush()

    resolveFirst(okResult([entry('first')], 1))
    await flush()

    expect(registry.getSnapshot(KEY).entries).toEqual([entry('second')])
  })

  it('marks a session gone when attach reports unknown-session', async () => {
    const sessionAttach = vi.fn().mockResolvedValue({ ok: false, kind: 'unknown-session' } satisfies SessionAttachResult)
    const registry = createEntriesRegistry({ sessionAttach })
    registry.subscribe(KEY, () => {})
    await flush()

    expect(registry.getSnapshot(KEY).gone).toBe(true)
  })

  it('forget clears a session back to its empty snapshot', async () => {
    const sessionAttach = vi.fn().mockResolvedValue(okResult([entry('a')], 1))
    const registry = createEntriesRegistry({ sessionAttach })
    registry.subscribe(KEY, () => {})
    await flush()
    expect(registry.getSnapshot(KEY).entries).toHaveLength(1)

    registry.forget(KEY)
    expect(registry.getSnapshot(KEY).entries).toEqual([])
  })
})
