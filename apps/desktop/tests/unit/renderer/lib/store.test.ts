import { describe, expect, it, vi } from 'vitest'
import { createStore } from '@/renderer/lib/store'

describe('createStore', () => {
  it('notifies subscribers with the new value readable', () => {
    const store = createStore(1)
    const seen: number[] = []
    store.subscribe(() => seen.push(store.get()))

    store.set(2)
    store.set(3)

    expect(seen).toEqual([2, 3])
  })

  it('stops notifying after unsubscribe', () => {
    const store = createStore(0)
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    unsubscribe()
    store.set(1)

    expect(listener).not.toHaveBeenCalled()
  })
})
