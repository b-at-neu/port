import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() } }))

import { toast } from 'sonner'
import { QueryClient } from '@tanstack/react-query'
import { ipcQueryOptions } from '@/renderer/data/query'
import { checkForUpdates, openDownloaded, runDownloadAction, startUpdate } from '@/renderer/update/actions'
import type { UpdateDownloadState, UpdateState } from '@/types/update'

const KEY = ipcQueryOptions('update:state').queryKey
const DOWNLOAD_KEY = ipcQueryOptions('update:download:state').queryKey
const BEFORE: UpdateState = { kind: 'idle', current: '0.1.0' }
const UP_TO_DATE: UpdateState = { kind: 'up-to-date', current: '0.1.0', latest: '0.1.0', trigger: 'manual', checkedAt: '2026-05-01T11:58:00Z' }

const AVAILABLE: UpdateState = {
  kind: 'available',
  current: '0.1.0',
  release: { version: '0.2.0', tag: 'v0.2.0', notesUrl: 'https://example.com/notes', publishedAt: null, assets: [] },
  trigger: 'startup',
  checkedAt: '2026-05-01T11:00:00Z',
}
const OFFLINE: UpdateState = { kind: 'error', current: '0.1.0', reason: 'offline', detail: 'offline', trigger: 'manual', checkedAt: '2026-05-01T11:58:00Z' }

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

  it('keeps a known available state when the check errors, and still toasts the failure', async () => {
    const client = new QueryClient()
    client.setQueryData(KEY, AVAILABLE)

    await checkForUpdates(client, vi.fn().mockResolvedValue(OFFLINE))

    expect(client.getQueryData(KEY)).toEqual(AVAILABLE)
    expect(toast.error).toHaveBeenCalled()
  })

  it('overwrites an error state with the next result', async () => {
    const client = new QueryClient()
    client.setQueryData(KEY, OFFLINE)

    await checkForUpdates(client, vi.fn().mockResolvedValue(UP_TO_DATE))

    expect(client.getQueryData(KEY)).toEqual(UP_TO_DATE)
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

const NOTES = 'https://example.com/notes'
const READY: UpdateDownloadState = { kind: 'ready', version: '0.2.0', notesUrl: NOTES, assetName: 'port-0.2.0-mac-arm64.dmg', path: '/d/port.dmg', package: 'dmg', opened: 'opened', openError: null, finishedAt: '2026-05-01T12:00:00Z' }
const FAILED: UpdateDownloadState = { kind: 'failed', version: '0.2.0', notesUrl: NOTES, assetName: 'port-0.2.0-mac-arm64.dmg', reason: 'interrupted', detail: 'x', failedAt: '2026-05-01T12:00:00Z' }
const NO_ASSET: UpdateDownloadState = { kind: 'no-asset', version: '0.2.0', notesUrl: NOTES, target: null }

function actionOf(call: readonly unknown[] | undefined): { label: string; onClick: () => void } {
  return (call?.[1] as { action: { label: string; onClick: () => void } }).action
}

describe('startUpdate', () => {
  it('writes the resolved state into the update:download:state cache and toasts it', async () => {
    const client = new QueryClient()
    const run = vi.fn().mockResolvedValue(READY)

    await startUpdate(client, run)

    expect(run).toHaveBeenCalledWith('update:download')
    expect(client.getQueryData(DOWNLOAD_KEY)).toEqual(READY)
    expect(toast.loading).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('port 0.2.0 downloaded', expect.objectContaining({ id: 'update-download' }))
  })

  it('toasts a failure with a Try again action that downloads again', async () => {
    const client = new QueryClient()
    const run = vi.fn().mockResolvedValueOnce(FAILED).mockResolvedValueOnce(READY)

    await startUpdate(client, run)

    expect(client.getQueryData(DOWNLOAD_KEY)).toEqual(FAILED)
    const action = actionOf(vi.mocked(toast.error).mock.calls[0])
    expect(action.label).toBe('Try again')

    action.onClick()
    await vi.waitFor(() => expect(client.getQueryData(DOWNLOAD_KEY)).toEqual(READY))
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('opens the release page from a missing-asset toast', async () => {
    const open = vi.fn()
    vi.stubGlobal('window', { open })
    try {
      await startUpdate(new QueryClient(), vi.fn().mockResolvedValue(NO_ASSET))
      actionOf(vi.mocked(toast.info).mock.calls[0]).onClick()
      expect(open).toHaveBeenCalledWith(NOTES, '_blank', 'noreferrer')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('toasts nothing for a resolved idle state', async () => {
    const client = new QueryClient()

    await startUpdate(client, vi.fn().mockResolvedValue({ kind: 'idle' }))

    expect(client.getQueryData(DOWNLOAD_KEY)).toEqual({ kind: 'idle' })
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.info).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('toasts the unreachable error and leaves the cache when the invoke rejects', async () => {
    const client = new QueryClient()
    client.setQueryData(DOWNLOAD_KEY, { kind: 'idle' })

    await startUpdate(client, vi.fn().mockRejectedValue(new Error('gone')))

    expect(client.getQueryData(DOWNLOAD_KEY)).toEqual({ kind: 'idle' })
    expect(toast.error).toHaveBeenCalledWith("Couldn't reach the main process. Restart port to try again.", expect.objectContaining({ id: 'update-download' }))
  })
})

describe('openDownloaded', () => {
  it.each([true, false])('passes { reveal: %j } and writes the result into the cache', async (reveal) => {
    const client = new QueryClient()
    const run = vi.fn().mockResolvedValue(READY)

    await openDownloaded(client, reveal, run)

    expect(run).toHaveBeenCalledWith('update:open', { reveal })
    expect(client.getQueryData(DOWNLOAD_KEY)).toEqual(READY)
  })

  it('toasts the unreachable error on a rejection', async () => {
    await openDownloaded(new QueryClient(), true, vi.fn().mockRejectedValue(new Error('gone')))

    expect(toast.error).toHaveBeenCalledWith("Couldn't reach the main process. Restart port to try again.", expect.objectContaining({ id: 'update-download' }))
  })
})

describe('runDownloadAction', () => {
  it('opens the release page for open-page', () => {
    const open = vi.fn()
    vi.stubGlobal('window', { open })
    try {
      runDownloadAction(new QueryClient(), 'open-page', NOTES)
      expect(open).toHaveBeenCalledWith(NOTES, '_blank', 'noreferrer')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
