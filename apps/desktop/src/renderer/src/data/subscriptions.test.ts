import { describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { connectQueryCache, createSubscriptions } from './subscriptions'
import type { SubscribableEvent, SubscriptionBridge } from './subscriptions'
import { ipcQueryOptions } from './query'
import type { BoardSnapshot } from '../../../shared/board/types'
import type { HostedSessionSnapshot, SessionEntriesDelta } from '../../../shared/hosting/types'
import type { AppCommand } from '../../../shared/shell/commands'

function fakeBridge(): SubscriptionBridge & { fire: (event: SubscribableEvent, payload: unknown) => void } {
  const sets: Record<SubscribableEvent, Set<(payload: unknown) => void>> = {
    'board:update': new Set(),
    'session:status': new Set(),
    'session:entries': new Set(),
    'app:command': new Set(),
  }
  const onBoardUpdate = vi.fn((listener: (payload: BoardSnapshot) => void) => {
    sets['board:update'].add(listener as (payload: unknown) => void)
    return () => sets['board:update'].delete(listener as (payload: unknown) => void)
  })
  const onSessionStatus = vi.fn((listener: (payload: HostedSessionSnapshot) => void) => {
    sets['session:status'].add(listener as (payload: unknown) => void)
    return () => sets['session:status'].delete(listener as (payload: unknown) => void)
  })
  const onSessionEntries = vi.fn((listener: (payload: SessionEntriesDelta) => void) => {
    sets['session:entries'].add(listener as (payload: unknown) => void)
    return () => sets['session:entries'].delete(listener as (payload: unknown) => void)
  })
  const onAppCommand = vi.fn((listener: (payload: AppCommand) => void) => {
    sets['app:command'].add(listener as (payload: unknown) => void)
    return () => sets['app:command'].delete(listener as (payload: unknown) => void)
  })
  return {
    onBoardUpdate,
    onSessionStatus,
    onSessionEntries,
    onAppCommand,
    fire: (event, payload) => {
      for (const listener of sets[event]) listener(payload)
    },
  }
}

describe('createSubscriptions', () => {
  it('attaches one bridge listener no matter how many subscribers', () => {
    const bridge = fakeBridge()
    const subs = createSubscriptions(bridge)
    subs.subscribe('board:update', () => {})
    subs.subscribe('board:update', () => {})
    subs.subscribe('board:update', () => {})
    expect(bridge.onBoardUpdate).toHaveBeenCalledTimes(1)
  })

  it('fans a push out to every current subscriber', () => {
    const bridge = fakeBridge()
    const subs = createSubscriptions(bridge)
    const seen: string[] = []
    subs.subscribe('board:update', () => seen.push('a'))
    subs.subscribe('board:update', () => seen.push('b'))
    bridge.fire('board:update', { ok: true })
    expect(seen).toEqual(['a', 'b'])
  })

  it('detaches the underlying bridge listener once the last subscriber leaves', () => {
    const bridge = fakeBridge()
    const subs = createSubscriptions(bridge)
    const unsubA = subs.subscribe('board:update', () => {})
    const unsubB = subs.subscribe('board:update', () => {})
    unsubA()
    expect(bridge.onBoardUpdate).toHaveBeenCalledTimes(1)
    unsubB()
    // A fresh subscribe after the last leave re-attaches — proof the
    // previous listener was actually detached, not just left idle.
    subs.subscribe('board:update', () => {})
    expect(bridge.onBoardUpdate).toHaveBeenCalledTimes(2)
  })

  it('keeps events independent — unsubscribing one never detaches another', () => {
    const bridge = fakeBridge()
    const subs = createSubscriptions(bridge)
    subs.subscribe('board:update', () => {})
    const unsubStatus = subs.subscribe('session:status', () => {})
    unsubStatus()
    expect(bridge.onBoardUpdate).toHaveBeenCalledTimes(1)
    expect(bridge.onSessionStatus).toHaveBeenCalledTimes(1)
  })
})

describe('connectQueryCache', () => {
  it('cancels the in-flight board:snapshot query before writing the push, so an older fetch can never overwrite a newer push', () => {
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

    const bridge = fakeBridge()
    connectQueryCache(client, createSubscriptions(bridge))
    bridge.fire('board:update', { snapshot: true })

    expect(order).toEqual(['cancel', 'set'])
    const key = ipcQueryOptions('board:snapshot').queryKey
    expect(cancelSpy).toHaveBeenCalledWith({ queryKey: key })
    expect(setSpy).toHaveBeenCalledWith(key, { snapshot: true })
  })
})
