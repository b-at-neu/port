import { describe, expect, it, vi } from 'vitest'
import { createTailStore } from './tail-store'
import type { TailStoreDeps } from './tail-store'
import type { TranscriptTailOpen, TranscriptTailPoll } from '../../../shared/sessions/transcript'

const SOURCE = { sessionId: 's', agentId: null, path: '', sizeBytes: 0, modifiedAt: 't', recordCount: 0, malformedLines: 0 }

function openResult(tailId: string): TranscriptTailOpen {
  return { ok: true, tailId, source: SOURCE, entries: [] }
}

function pollResult(hasMore = false): TranscriptTailPoll {
  return { ok: true, source: SOURCE, appended: [], patched: [], hasMore }
}

function fakeDeps(overrides: Partial<TailStoreDeps> = {}): TailStoreDeps {
  return {
    tailOpen: vi.fn().mockResolvedValue(openResult('tail-1')),
    tailPoll: vi.fn().mockResolvedValue(pollResult()),
    tailClose: vi.fn().mockResolvedValue(undefined),
    isHidden: () => false,
    onVisibilityChange: () => () => {},
    ...overrides,
  }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('createTailStore', () => {
  it('opens on first subscribe and reaches ready', async () => {
    const deps = fakeDeps()
    const store = createTailStore(deps)
    store.subscribe('s', null, () => {})
    await flush()

    expect(deps.tailOpen).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().status).toBe('ready')
  })

  it('supersedes a stale open when the target changes before it resolves', async () => {
    let resolveFirst: (result: TranscriptTailOpen) => void = () => {}
    const tailOpen = vi
      .fn()
      .mockReturnValueOnce(new Promise<TranscriptTailOpen>((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce(openResult('tail-second'))
    const deps = fakeDeps({ tailOpen })
    const store = createTailStore(deps)

    store.subscribe('s1', null, () => {})
    store.subscribe('s2', null, () => {}) // a second reader for a different target supersedes the first
    await flush()

    resolveFirst(openResult('tail-first'))
    await flush()

    const snapshot = store.getSnapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.status === 'ready' && snapshot.source.sessionId).toBe('s')
    expect(deps.tailClose).not.toHaveBeenCalled() // the stale open never produced a tailId to close
  })

  it('stops polling while hidden and resumes on visibility change', async () => {
    let visibilityListener: () => void = () => {}
    let hidden = false
    const deps = fakeDeps({
      isHidden: () => hidden,
      onVisibilityChange: (listener) => {
        visibilityListener = listener
        return () => {}
      },
    })
    const store = createTailStore(deps)
    store.subscribe('s', null, () => {})
    await flush()

    hidden = true
    visibilityListener()
    await flush()
    expect(deps.tailPoll).not.toHaveBeenCalled()

    hidden = false
    visibilityListener()
    await flush()
    expect(deps.tailPoll).toHaveBeenCalledTimes(1)
  })

  it('closes the tail once the last listener unsubscribes', async () => {
    const deps = fakeDeps()
    const store = createTailStore(deps)
    const unsubscribeA = store.subscribe('s', null, () => {})
    const unsubscribeB = store.subscribe('s', null, () => {})
    await flush()

    unsubscribeA()
    expect(deps.tailClose).not.toHaveBeenCalled()

    unsubscribeB()
    expect(deps.tailClose).toHaveBeenCalledWith('tail-1')
  })

  it('re-subscribing after closing opens a fresh tail', async () => {
    const deps = fakeDeps()
    const store = createTailStore(deps)
    const unsubscribe = store.subscribe('s', null, () => {})
    await flush()
    unsubscribe()

    store.subscribe('s', null, () => {})
    await flush()
    expect(deps.tailOpen).toHaveBeenCalledTimes(2)
  })
})
