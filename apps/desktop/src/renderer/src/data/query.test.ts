import { describe, expect, it, vi } from 'vitest'

vi.mock('./invoke', () => ({ invoke: vi.fn() }))

import { createQueryClient, ipcQueryOptions } from './query'
import { invoke } from './invoke'

describe('createQueryClient', () => {
  it('defaults to networkMode always, no retry, and no refetch on focus', () => {
    const client = createQueryClient()
    const defaults = client.getDefaultOptions()
    expect(defaults.queries?.networkMode).toBe('always')
    expect(defaults.queries?.retry).toBe(false)
    expect(defaults.queries?.refetchOnWindowFocus).toBe(false)
    expect(defaults.mutations?.networkMode).toBe('always')
    expect(defaults.mutations?.retry).toBe(false)
  })
})

describe('ipcQueryOptions', () => {
  it('keys a query by channel and request, request defaulting to null', () => {
    expect(ipcQueryOptions('app:info').queryKey).toEqual(['app:info', null])
    expect(ipcQueryOptions('worktrees:report', { id: 'repo-1' as never }).queryKey).toEqual(['worktrees:report', { id: 'repo-1' }])
  })

  it('gives board:snapshot an infinite staleTime, kept fresh by the push subscription instead', () => {
    expect(ipcQueryOptions('board:snapshot').staleTime).toBe(Infinity)
    expect(ipcQueryOptions('app:info').staleTime).toBeUndefined()
  })

  it('an ok:false response resolves as data, never as an error', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ ok: false, kind: 'registry-unreadable', message: 'nope' })
    const options = ipcQueryOptions('repos:list')
    await expect(options.queryFn!({} as never)).resolves.toEqual({ ok: false, kind: 'registry-unreadable', message: 'nope' })
  })

  it('a rejected invoke becomes the query error', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('unreachable'))
    const options = ipcQueryOptions('repos:list')
    await expect(options.queryFn!({} as never)).rejects.toThrow('unreachable')
  })
})
