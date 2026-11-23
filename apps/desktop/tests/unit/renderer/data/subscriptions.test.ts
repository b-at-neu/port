import { describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { connectQueryCache, createSubscriptions } from '@/renderer/data/subscriptions'
import type { SubscribableEvent, SubscriptionBridge } from '@/types/data'
import { ipcQueryOptions } from '@/renderer/data/query'
import type { ReposListResponse } from '@/types/ipc'

/** Records every attach per event, so a test can count how many bridge listeners were ever opened. */
function fakeBridge() {
  const sets: Record<SubscribableEvent, Set<(payload: unknown) => void>> = {
    'board.update': new Set(),
    'session.status': new Set(),
    'session.entries': new Set(),
    'app.command': new Set(),
  }
  const attached: Record<SubscribableEvent, number> = { 'board.update': 0, 'session.status': 0, 'session.entries': 0, 'app.command': 0 }
  const bridge: SubscriptionBridge = {
    on: (event, listener) => {
      attached[event] += 1
      const set = sets[event]
      const wrapped = listener as (payload: unknown) => void
      set.add(wrapped)
      return () => set.delete(wrapped)
    },
  }
  return {
    bridge,
    attached,
    fire: (event: SubscribableEvent, payload: unknown) => {
      for (const listener of sets[event]) listener(payload)
    },
  }
}

describe('createSubscriptions', () => {
  it('attaches one bridge listener no matter how many subscribers', () => {
    const { bridge, attached } = fakeBridge()
    const subs = createSubscriptions(bridge)
    subs.subscribe('board.update', () => {})
    subs.subscribe('board.update', () => {})
    subs.subscribe('board.update', () => {})
    expect(attached['board.update']).toBe(1)
  })

  it('fans a push out to every current subscriber', () => {
    const { bridge, fire } = fakeBridge()
    const subs = createSubscriptions(bridge)
    const seen: string[] = []
    subs.subscribe('board.update', () => seen.push('a'))
    subs.subscribe('board.update', () => seen.push('b'))
    fire('board.update', { ok: true })
    expect(seen).toEqual(['a', 'b'])
  })

  it('detaches the underlying bridge listener once the last subscriber leaves', () => {
    const { bridge, attached } = fakeBridge()
    const subs = createSubscriptions(bridge)
    const unsubA = subs.subscribe('board.update', () => {})
    const unsubB = subs.subscribe('board.update', () => {})
    unsubA()
    expect(attached['board.update']).toBe(1)
    unsubB()
    // A fresh subscribe after the last leave re-attaches — proof the
    // previous listener was actually detached, not just left idle.
    subs.subscribe('board.update', () => {})
    expect(attached['board.update']).toBe(2)
  })

  it('keeps events independent — unsubscribing one never detaches another', () => {
    const { bridge, attached } = fakeBridge()
    const subs = createSubscriptions(bridge)
    subs.subscribe('board.update', () => {})
    const unsubStatus = subs.subscribe('session.status', () => {})
    unsubStatus()
    expect(attached['board.update']).toBe(1)
    expect(attached['session.status']).toBe(1)
  })
})

describe('connectQueryCache', () => {
  it('cancels the in-flight board.snapshot query before writing the push, so an older fetch can never overwrite a newer push', () => {
    const client = new QueryClient()
    const order: string[] = []
    const cancelSpy = vi.spyOn(client, 'cancelQueries').mockImplementation(() => {
      order.push('cancel')
      return Promise.resolve()
    })
    const setSpy = vi.spyOn(client, 'setQueryData').mockImplementation(() => {
      order.push('set')
      return undefined
    })

    const { bridge, fire } = fakeBridge()
    connectQueryCache(client, createSubscriptions(bridge))
    fire('board.update', { snapshot: true })

    expect(order).toEqual(['cancel', 'set'])
    const key = ipcQueryOptions('board.snapshot').queryKey
    expect(cancelSpy).toHaveBeenCalledWith({ queryKey: key })
    expect(setSpy).toHaveBeenCalledWith(key, { snapshot: true })
  })

  describe('session.index invalidation', () => {
    const indexKey = ipcQueryOptions('session.index').queryKey

    function invalidationsFor(phase: string): number {
      const client = new QueryClient()
      const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined)
      const { bridge, fire } = fakeBridge()
      connectQueryCache(client, createSubscriptions(bridge))
      fire('session.status', { sessionKey: 'hosted-1', phase })
      return invalidate.mock.calls.filter(([filter]) => JSON.stringify(filter?.queryKey) === JSON.stringify(indexKey)).length
    }

    it('invalidates the index when a pushed snapshot has ended', () => {
      expect(invalidationsFor('ended')).toBe(1)
    })

    it('leaves it alone for a streaming push', () => {
      expect(invalidationsFor('streaming')).toBe(0)
    })
  })

  describe('repos.list invalidation', () => {
    const reposKey = ipcQueryOptions('repos.list').queryKey
    const notReady = { id: 'repo-a', path: '/a', displayName: 'o/a', problem: { kind: 'directory-missing' }, diagnostics: [] }
    const ready = { id: 'repo-a', path: '/a', displayName: 'o/a', status: 'ready', config: {}, diagnostics: [] }
    const snapshotWith = (ok: boolean) => ({ state: { repositories: [ok ? { ok: true, repoId: 'repo-a' } : { ok: false, repoId: 'repo-a', reason: 'not-ready' }] } })

    function pushWith(cached: unknown, ok: boolean): number {
      const client = new QueryClient()
      if (cached !== undefined) client.setQueryData(reposKey, cached as ReposListResponse)
      const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined)
      const { bridge, fire } = fakeBridge()
      connectQueryCache(client, createSubscriptions(bridge))
      fire('board.update', snapshotWith(ok))
      return invalidate.mock.calls.filter(([filter]) => JSON.stringify(filter?.queryKey) === JSON.stringify(reposKey)).length
    }

    it('invalidates when the board reports a repository ok that the cache still lists as not ready', () => {
      expect(pushWith({ ok: true, repositories: [notReady] }, true)).toBe(1)
    })

    it('invalidates when the cache does not list the repository at all', () => {
      expect(pushWith({ ok: true, repositories: [] }, true)).toBe(1)
    })

    it('leaves a matching cache alone', () => {
      expect(pushWith({ ok: true, repositories: [ready] }, true)).toBe(0)
    })

    it('never invalidates for a repository whose own read failed', () => {
      expect(pushWith({ ok: true, repositories: [notReady] }, false)).toBe(0)
    })

    it('does nothing before repos.list has been read, or after it failed to load', () => {
      expect(pushWith(undefined, true)).toBe(0)
      expect(pushWith({ ok: false, kind: 'registry-unreadable', message: 'x' }, true)).toBe(0)
    })
  })
})
