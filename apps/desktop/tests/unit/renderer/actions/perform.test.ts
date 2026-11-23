import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() } }))

import { toast } from 'sonner'
import { perform } from '@/renderer/actions/perform'
import type { PerformDeps } from '@/renderer/actions/perform'
import { createQueryClient } from '@/renderer/data/query'

const NAME = 'session.close' as const
const KEY = ['session.list']

type Reply = 'ok' | 'refused' | 'rejected'

function depsFor(reply: Reply): PerformDeps {
  const client = createQueryClient()
  client.setQueryData(KEY, [])
  const invoke = vi.fn(() => (reply === 'rejected' ? Promise.reject(new Error('gone')) : Promise.resolve({ ok: reply === 'ok' })))
  return { invoke: invoke as unknown as PerformDeps['invoke'], client }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('perform', () => {
  it.each([
    ['ok', { ok: true }, 'success'],
    ['refused', { ok: false }, 'error'],
    ['rejected', 'unreachable', 'error'],
  ] as const)('a %s reply returns %j and toasts %s when a toast is set', async (reply, returned, tone) => {
    const deps = depsFor(reply)
    const result = await perform(
      { name: NAME, input: {} as never, invalidates: ['session.list'], toast: { pending: 'Working', result: (output) => ({ tone: (output as { ok: boolean }).ok ? 'success' : 'error', title: 'T', description: null, action: null, cancel: null }) } },
      deps,
    )

    expect(result).toEqual(returned)
    expect(toast[tone]).toHaveBeenCalledTimes(1)
    expect(deps.client.getQueryState(KEY)?.isInvalidated).toBe(true)
  })

  it.each([
    ['ok', { ok: true }, 0],
    ['refused', { ok: false }, 0],
    ['rejected', 'unreachable', 1],
  ] as const)('a %s reply returns %j with %d error toasts when no toast is set', async (reply, returned, errors) => {
    const deps = depsFor(reply)
    const result = await perform({ name: NAME, input: {} as never, invalidates: ['session.list'] }, deps)

    expect(result).toEqual(returned)
    expect(toast.error).toHaveBeenCalledTimes(errors)
    expect(toast.loading).not.toHaveBeenCalled()
    expect(deps.client.getQueryState(KEY)?.isInvalidated).toBe(true)
  })

  it('invalidates nothing when no keys are given', async () => {
    const deps = depsFor('ok')
    await perform({ name: NAME, input: {} as never }, deps)

    expect(deps.client.getQueryState(KEY)?.isInvalidated).toBe(false)
  })
})
