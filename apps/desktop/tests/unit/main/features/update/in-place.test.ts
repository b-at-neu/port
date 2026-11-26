import { describe, expect, it, vi } from 'vitest'
import { createInPlaceUpdater } from '@/main/features/update/in-place'
import type { AvailableRelease, NativeUpdateInfo, NativeUpdater, UpdateDownloader, UpdateDownloadState } from '@/types/update'
import { createFakeClock, fakeUpdates } from '../../../../support/fake-platform'

const RELEASE: AvailableRelease = { version: '0.2.0', tag: 'v0.2.0', notesUrl: 'https://example.test/notes', publishedAt: null, assets: [] }
const NOW = new Date('2026-05-01T12:00:00Z')
const FALLBACK_STATE: UpdateDownloadState = { kind: 'downloading', version: '0.2.0', notesUrl: RELEASE.notesUrl, assetName: 'port-0.2.0.exe', receivedBytes: 0, totalBytes: 10, startedAt: NOW.toISOString() }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setup(options: { release?: AvailableRelease | null; confirm?: boolean } = {}) {
  const check = deferred<NativeUpdateInfo | null>()
  const download = deferred<void>()
  let errorListener: (message: string) => void = () => undefined
  let progress: (transferred: number, total: number) => void = () => undefined
  const native: NativeUpdater = {
    check: vi.fn(() => check.promise),
    download: vi.fn((onProgress: (transferred: number, total: number) => void) => {
      progress = onProgress
      return download.promise
    }),
    install: vi.fn(),
    onError: vi.fn((listener: (message: string) => void) => {
      errorListener = listener
    }),
  }
  const nativeFactory = vi.fn(() => native)
  const fallback: UpdateDownloader = {
    state: vi.fn(() => FALLBACK_STATE),
    start: vi.fn(() => Promise.resolve(FALLBACK_STATE)),
    open: vi.fn(() => Promise.resolve(FALLBACK_STATE)),
  }
  const confirmRestart = vi.fn(() => Promise.resolve(options.confirm ?? true))
  const cancelRestart = vi.fn()
  const release = options.release === undefined ? RELEASE : options.release
  const clock = createFakeClock(NOW)
  const updater = createInPlaceUpdater({ updates: fakeUpdates({ native: nativeFactory }), clock }, { release: () => release, fallback, restart: { confirm: confirmRestart, cancel: cancelRestart } })
  return { updater, clock, native, nativeFactory, fallback, confirmRestart, cancelRestart, check, download, emitError: (m: string) => errorListener(m), emitProgress: (t: number, total: number) => progress(t, total) }
}

const MATCH: NativeUpdateInfo = { version: '0.2.0', fileName: 'port-0.2.0-win-x64.exe' }

async function toRestarting(s: ReturnType<typeof setup>): Promise<UpdateDownloadState> {
  const pending = s.updater.start()
  s.check.resolve(MATCH)
  await Promise.resolve()
  await Promise.resolve()
  s.download.resolve()
  return pending
}

describe('createInPlaceUpdater', () => {
  it('is downloading synchronously after start, and progress updates its bytes', async () => {
    const s = setup()
    void s.updater.start()
    expect(s.updater.state()).toMatchObject({ kind: 'downloading', assetName: '', receivedBytes: 0, totalBytes: 0 })
    s.check.resolve(MATCH)
    await vi.waitFor(() => expect(s.native.download).toHaveBeenCalled())
    s.emitProgress(5, 10)
    expect(s.updater.state()).toMatchObject({ kind: 'downloading', assetName: MATCH.fileName, receivedBytes: 5, totalBytes: 10 })
  })

  it('checks, downloads, confirms, installs once and resolves restarting', async () => {
    const s = setup()
    const result = await toRestarting(s)
    expect(result.kind).toBe('restarting')
    expect(s.confirmRestart).toHaveBeenCalledOnce()
    expect(s.native.install).toHaveBeenCalledOnce()
    expect(s.updater.state().kind).toBe('restarting')
  })

  it('joins a second start and checks once', async () => {
    const s = setup()
    const first = s.updater.start()
    const second = s.updater.start()
    expect(second).toBe(first)
    s.check.resolve(MATCH)
    await vi.waitFor(() => expect(s.native.download).toHaveBeenCalled())
    s.download.resolve()
    await first
    expect(s.native.check).toHaveBeenCalledOnce()
  })

  it('never constructs the native updater without a release', async () => {
    const s = setup({ release: null })
    expect(await s.updater.start()).toEqual({ kind: 'idle' })
    expect(s.nativeFactory).not.toHaveBeenCalled()
  })

  describe('falls back', () => {
    it('when the feed offers no update', async () => {
      const s = setup()
      const pending = s.updater.start()
      s.check.resolve(null)
      await pending
      expect(s.fallback.start).toHaveBeenCalledOnce()
      expect(s.updater.state()).toBe(FALLBACK_STATE)
    })

    it('when the feed version differs from the service', async () => {
      const s = setup()
      const pending = s.updater.start()
      s.check.resolve({ version: '0.3.0', fileName: 'x' })
      await pending
      expect(s.fallback.start).toHaveBeenCalledOnce()
      expect(s.native.download).not.toHaveBeenCalled()
    })

    it('when check throws', async () => {
      const s = setup()
      const pending = s.updater.start()
      s.check.reject(new Error('offline'))
      await pending
      expect(s.fallback.start).toHaveBeenCalledOnce()
    })

    it('when download rejects', async () => {
      const s = setup()
      const pending = s.updater.start()
      s.check.resolve(MATCH)
      await vi.waitFor(() => expect(s.native.download).toHaveBeenCalled())
      s.download.reject(new Error('interrupted'))
      await pending
      expect(s.fallback.start).toHaveBeenCalledOnce()
      expect(s.native.install).not.toHaveBeenCalled()
    })

    it('when install throws, and cancels the restart', async () => {
      const s = setup()
      vi.mocked(s.native.install).mockImplementation(() => {
        throw new Error('spawn failed')
      })
      await toRestarting(s)
      expect(s.cancelRestart).toHaveBeenCalledOnce()
      expect(s.fallback.start).toHaveBeenCalledOnce()
    })

    it('on an async error while restarting, and cancels the restart', async () => {
      const s = setup()
      await toRestarting(s)
      s.emitError('installer failed')
      expect(s.cancelRestart).toHaveBeenCalledOnce()
      expect(s.fallback.start).toHaveBeenCalledOnce()
    })
  })

  it('ignores an async error outside restarting', async () => {
    const s = setup()
    const pending = s.updater.start()
    s.check.resolve(MATCH)
    await vi.waitFor(() => expect(s.native.download).toHaveBeenCalled())
    s.emitError('transient')
    expect(s.fallback.start).not.toHaveBeenCalled()
    s.download.resolve()
    await pending
  })

  it('after a fallback, start goes straight to the fallback and the native updater is untouched', async () => {
    const s = setup()
    const pending = s.updater.start()
    s.check.resolve(null)
    await pending
    await s.updater.start()
    expect(s.fallback.start).toHaveBeenCalledTimes(2)
    expect(s.native.check).toHaveBeenCalledOnce()
  })

  it('a declined restart is restart-pending and installs nothing, and a later start restarts without downloading again', async () => {
    const s = setup({ confirm: false })
    const result = await toRestarting(s)
    expect(result.kind).toBe('restart-pending')
    expect(s.native.install).not.toHaveBeenCalled()
    s.confirmRestart.mockResolvedValueOnce(true)
    const again = await s.updater.start()
    expect(again.kind).toBe('restarting')
    expect(s.native.download).toHaveBeenCalledOnce()
    expect(s.native.install).toHaveBeenCalledOnce()
  })

  it('a restart that never quits becomes restart-pending again, and a later start retries it', async () => {
    const s = setup()
    await toRestarting(s)
    expect(s.updater.state().kind).toBe('restarting')
    s.clock.advance(121_000)
    expect(s.updater.state().kind).toBe('restart-pending')
    const again = await s.updater.start()
    expect(again.kind).toBe('restarting')
    expect(s.native.install).toHaveBeenCalledTimes(2)
    expect(s.native.download).toHaveBeenCalledOnce()
  })

  it('delegates open to the fallback', async () => {
    const s = setup()
    await s.updater.open(true)
    expect(s.fallback.open).toHaveBeenCalledWith(true)
  })
})
