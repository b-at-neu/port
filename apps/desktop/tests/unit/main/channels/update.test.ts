import { describe, expect, it } from 'vitest'
import { resolveUpdateCheck, resolveUpdateState } from '@/main/channels/update'
import type { UpdateService, UpdateState } from '@/types/update'

const STATE: UpdateState = { kind: 'idle', current: '1.4.0' }

function serviceOf(calls: string[] = []): UpdateService {
  return {
    state: () => STATE,
    check: (trigger) => {
      calls.push(trigger)
      return Promise.resolve(STATE)
    },
  }
}

describe('resolveUpdateState', () => {
  it('returns the cached state', () => {
    expect(resolveUpdateState(undefined, serviceOf())).toBe(STATE)
  })

  it.each([null, {}, 'x', 0])('throws on the payload %j', (payload) => {
    expect(() => resolveUpdateState(payload, serviceOf())).toThrow("'update:state' takes no payload")
  })
})

describe('resolveUpdateCheck', () => {
  it('runs a manual check', async () => {
    const calls: string[] = []
    expect(await resolveUpdateCheck(undefined, serviceOf(calls))).toBe(STATE)
    expect(calls).toEqual(['manual'])
  })

  it.each([null, {}, 'x', 0])('throws on the payload %j without checking', (payload) => {
    const calls: string[] = []
    expect(() => resolveUpdateCheck(payload, serviceOf(calls))).toThrow("'update:check' takes no payload")
    expect(calls).toEqual([])
  })
})
