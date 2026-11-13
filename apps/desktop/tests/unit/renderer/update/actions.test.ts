import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() } }))

import { toast } from 'sonner'
import { QueryClient } from '@tanstack/react-query'
import { ipcQueryOptions } from '@/renderer/data/query'
import { checkForUpdates } from '@/renderer/update/actions'
import type { UpdateState } from '@/types/update'

const KEY = ipcQueryOptions('update:state').queryKey
const BEFORE: UpdateState = { kind: 'idle', current: '0.1.0' }
const UP_TO_DATE: UpdateState = { kind: 'up-to-date', current: '0.1.0', latest: '0.1.0', trigger: 'manual', checkedAt: '2026-05-01T11:58:00Z' }

function seededClient(): QueryClient {
  const client = new QueryClient()
  client.setQueryData(KEY, BEFORE)
  return client
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('checkForUpdates', () => {
  it('writes the result into the update:state cache and toasts it', async () => {
    const client = seededClient()
    const run = vi.fn().mockResolvedValue(UP_TO_DATE)

    await checkForUpdates(client, run)

    expect(run).toHaveBeenCalledWith('update:check')
    expect(client.getQueryData(KEY)).toEqual(UP_TO_DATE)
    expect(toast.loading).toHaveBeenCalledWith('Checking for updates…', expect.objectContaining({ id: 'update-check' }))
    expect(toast.success).toHaveBeenCalledWith('port is up to date', expect.objectContaining({ id: 'update-check', description: '0.1.0 is the latest release.' }))
  })

  it('does nothing while a check is already pending', async () => {
    const client = seededClient()
    let release: (state: UpdateState) => void = () => undefined
    const run = vi.fn().mockReturnValue(
      new Promise<UpdateState>((resolve) => {
        release = resolve
      }),
    )

    const first = checkForUpdates(client, run)
    await checkForUpdates(client, run)
    expect(run).toHaveBeenCalledOnce()

    release(UP_TO_DATE)
    await first
  })

  it('leaves the cache untouched when the invoke rejects, and can run again', async () => {
    const client = seededClient()

    await checkForUpdates(client, vi.fn().mockRejectedValue(new Error('gone')))

    expect(client.getQueryData(KEY)).toEqual(BEFORE)
    expect(toast.error).toHaveBeenCalledWith("Couldn't reach the main process. Restart port to try again.", expect.objectContaining({ id: 'update-check' }))

    const run = vi.fn().mockResolvedValue(UP_TO_DATE)
    await checkForUpdates(client, run)
    expect(run).toHaveBeenCalledOnce()
  })
})
