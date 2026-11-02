import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() } }))

import { toast } from 'sonner'
import { runInBackground, showActionToast } from '@/renderer/lib/background-action'
import type { ActionToast } from '@/types/toast'

function result(tone: ActionToast['tone'], extra: Partial<ActionToast> = {}): ActionToast {
  return { tone, title: 'Done.', description: null, action: null, cancel: null, ...extra }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('runInBackground', () => {
  it.each([
    ['success', toast.success],
    ['error', toast.error],
    ['info', toast.info],
  ] as const)('shows a loading toast, then replaces it with a %s toast under the same id', async (tone, fn) => {
    const value = await runInBackground({ id: 'x', pending: 'Working…', run: () => Promise.resolve(7), toToast: () => result(tone) })

    expect(value).toBe(7)
    expect(toast.loading).toHaveBeenCalledWith('Working…', expect.objectContaining({ id: 'x' }))
    expect(fn).toHaveBeenCalledWith('Done.', expect.objectContaining({ id: 'x' }))
  })

  it('dismisses the loading toast when the mapper returns null', async () => {
    await runInBackground({ id: 'x', pending: 'Working…', run: () => Promise.resolve(1), toToast: () => null })

    expect(toast.dismiss).toHaveBeenCalledWith('x')
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('shows the unreachable error toast when the run rejects', async () => {
    const value = await runInBackground({ id: 'x', pending: 'Working…', run: () => Promise.reject(new Error('gone')), toToast: () => result('success') })

    expect(value).toBe('unreachable')
    expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toBe("Couldn't reach the main process. Restart port to try again.")
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('shows a caller-supplied unreachable toast instead of the default', async () => {
    await runInBackground({ id: 'x', pending: 'Working…', run: () => Promise.reject(new Error('gone')), toToast: () => result('success'), unreachable: result('error', { title: 'Custom.' }) })

    expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toBe('Custom.')
  })
})

describe('showActionToast', () => {
  it('clears a stale action, cancel and duration when the toast carries none', () => {
    showActionToast('x', result('success'))

    expect(vi.mocked(toast.success).mock.calls[0]?.[1]).toMatchObject({ id: 'x', action: undefined, cancel: undefined, duration: undefined, description: undefined })
  })

  it('passes the action and cancel buttons through', () => {
    const onClick = vi.fn()
    showActionToast('x', result('error', { description: 'why', action: { label: 'Retry', onClick }, cancel: { label: 'Show', onClick } }))

    expect(vi.mocked(toast.error).mock.calls[0]?.[1]).toMatchObject({ description: 'why', action: { label: 'Retry', onClick }, cancel: { label: 'Show', onClick } })
  })
})
