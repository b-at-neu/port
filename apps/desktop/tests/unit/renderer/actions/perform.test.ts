import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() } }))

import { toast } from 'sonner'
import { perform } from '@/renderer/actions/perform'
import type { PerformDeps } from '@/renderer/actions/perform'
import { createQueryClient } from '@/renderer/data/query'
import type { ActionToast } from '@/types/toast'

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

  it.each([
    ['ok', { ok: true }, 'success'],
    ['refused', { ok: false }, 'error'],
    ['rejected', 'unreachable', 'error'],
  ] as const)('a %s reply returns %j and toasts %s without a loading toast when pending is omitted', async (reply, returned, tone) => {
    const deps = depsFor(reply)
    const result = await perform(
      { name: NAME, input: {} as never, invalidates: ['session.list'], toast: { result: (output) => ({ tone: (output as { ok: boolean }).ok ? 'success' : 'error', title: 'T', description: null, action: null, cancel: null }) } },
      deps,
    )

    expect(result).toEqual(returned)
    expect(toast.loading).not.toHaveBeenCalled()
    expect(toast[tone]).toHaveBeenCalledTimes(1)
    expect(deps.client.getQueryState(KEY)?.isInvalidated).toBe(true)
  })

  const CUSTOM: ActionToast = { tone: 'error', title: 'Custom', description: null, action: null, cancel: null }

  it.each([
    ['pending', 'a null override', null, 0, 0],
    ['plain', 'a null override', null, 0, 0],
    ['pending', 'a custom toast', CUSTOM, 1, 0],
    ['plain', 'a custom toast', CUSTOM, 1, 0],
  ] as const)('a rejected invoke on the %s branch with %s still returns unreachable', async (branch, _name, unreachable, errors, successes) => {
    const deps = depsFor('rejected')
    const result = await perform({ name: NAME, input: {} as never, toast: { ...(branch === 'pending' ? { pending: 'Working' } : {}), result: () => null, unreachable } }, deps)

    expect(result).toBe('unreachable')
    expect(toast.error).toHaveBeenCalledTimes(errors)
    expect(toast.success).toHaveBeenCalledTimes(successes)
    if (unreachable !== null) expect(toast.error).toHaveBeenCalledWith('Custom', expect.anything())
    if (branch === 'pending' && unreachable === null) expect(toast.dismiss).toHaveBeenCalledTimes(1)
  })

  it('shows no toast when the result maps to null', async () => {
    const deps = depsFor('ok')
    await perform({ name: NAME, input: {} as never, toast: { result: () => null } }, deps)

    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('invalidates nothing when no keys are given', async () => {
    const deps = depsFor('ok')
    await perform({ name: NAME, input: {} as never }, deps)

    expect(deps.client.getQueryState(KEY)?.isInvalidated).toBe(false)
  })
})
