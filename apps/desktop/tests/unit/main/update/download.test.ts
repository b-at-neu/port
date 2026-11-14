import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createUpdateDownloader } from '@/main/update/download'
import type { UpdateDownloaderDeps } from '@/main/update/download'
import type { AvailableRelease, FileDownloadRequest, FileDownloadResult, InstallTarget } from '@/types/update'

const REPO = 'acme/port'
const DMG = 'port-1.5.0-mac-arm64.dmg'
const SIZE = 1000

const ASSET = { name: DMG, url: `https://github.com/${REPO}/releases/download/v1.5.0/${DMG}`, size: SIZE, contentType: null }
const RELEASE: AvailableRelease = { version: '1.5.0', tag: 'v1.5.0', notesUrl: 'https://example.test/notes', publishedAt: null, assets: [ASSET] }
const MAC: InstallTarget = { os: 'mac', arch: 'arm64', package: 'dmg' }
const APPIMAGE: InstallTarget = { os: 'linux', arch: 'x64', package: 'appimage' }
const APPIMAGE_RELEASE: AvailableRelease = {
  ...RELEASE,
  assets: [{ name: 'port-1.5.0-linux-x86_64.AppImage', url: `https://github.com/${REPO}/releases/download/v1.5.0/port-1.5.0-linux-x86_64.AppImage`, size: SIZE, contentType: null }],
}

interface Harness {
  readonly deps: UpdateDownloaderDeps
  readonly download: ReturnType<typeof vi.fn>
  readonly open: ReturnType<typeof vi.fn>
  readonly reveal: ReturnType<typeof vi.fn>
  readonly requests: FileDownloadRequest[]
  readonly finish: (result: FileDownloadResult) => void
}

function harness(overrides: Partial<UpdateDownloaderDeps> = {}): Harness {
  const requests: FileDownloadRequest[] = []
  let finish: (result: FileDownloadResult) => void = () => undefined
  const download = vi.fn((request: FileDownloadRequest) => {
    requests.push(request)
    return new Promise<FileDownloadResult>((resolve) => {
      finish = resolve
    })
  })
  const open = vi.fn().mockResolvedValue('')
  const reveal = vi.fn()
  const deps: UpdateDownloaderDeps = {
    release: () => RELEASE,
    target: MAC,
    repo: REPO,
    downloadsDir: () => '/downloads',
    download,
    open,
    reveal,
    now: () => new Date('2026-05-01T12:00:00Z'),
    ...overrides,
  }
  return { deps, download, open, reveal, requests, finish: (result) => finish(result) }
}

const completed: FileDownloadResult = { ok: true, path: `/downloads/${DMG}`, receivedBytes: SIZE }

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('createUpdateDownloader', () => {
  it('is downloading synchronously after start, with the asset size as the total', () => {
    const h = harness()
    const downloader = createUpdateDownloader(h.deps)

    void downloader.start()

    expect(downloader.state()).toMatchObject({ kind: 'downloading', version: '1.5.0', assetName: DMG, receivedBytes: 0, totalBytes: SIZE })
    expect(h.requests[0]).toMatchObject({ url: ASSET.url, savePath: `/downloads/${DMG}` })
  })

  it('tracks progress and keeps the asset size when the transport reports no total', () => {
    const h = harness()
    const downloader = createUpdateDownloader(h.deps)
    void downloader.start()

    h.requests[0]?.onProgress(400, 0)
    expect(downloader.state()).toMatchObject({ kind: 'downloading', receivedBytes: 400, totalBytes: SIZE })

    h.requests[0]?.onProgress(600, 1200)
    expect(downloader.state()).toMatchObject({ receivedBytes: 600, totalBytes: 1200 })
  })

  it('joins a download in flight rather than starting a second one', async () => {
    const h = harness()
    const downloader = createUpdateDownloader(h.deps)

    const first = downloader.start()
    const second = downloader.start()
    h.finish(completed)

    expect(await first).toBe(await second)
    expect(h.download).toHaveBeenCalledOnce()
  })

  it('opens the installer once it completes', async () => {
    const h = harness()
    const downloader = createUpdateDownloader(h.deps)
    const done = downloader.start()
    h.finish(completed)

    expect(await done).toMatchObject({ kind: 'ready', assetName: DMG, path: `/downloads/${DMG}`, package: 'dmg', opened: 'opened', openError: null })
    expect(h.open).toHaveBeenCalledWith(`/downloads/${DMG}`)
    expect(h.reveal).not.toHaveBeenCalled()
  })

  it('reveals the file and records the error when opening fails', async () => {
    const h = harness()
    h.open.mockResolvedValue('no application')
    const downloader = createUpdateDownloader(h.deps)
    const done = downloader.start()
    h.finish(completed)

    expect(await done).toMatchObject({ kind: 'ready', opened: 'revealed', openError: 'no application' })
    expect(h.reveal).toHaveBeenCalledWith(`/downloads/${DMG}`)
  })

  it('only reveals an AppImage', async () => {
    const h = harness({ target: APPIMAGE, release: () => APPIMAGE_RELEASE })
    const downloader = createUpdateDownloader(h.deps)
    const done = downloader.start()
    h.finish({ ok: true, path: '/downloads/port-1.5.0-linux-x86_64.AppImage', receivedBytes: SIZE })

    expect(await done).toMatchObject({ kind: 'ready', package: 'appimage', opened: 'revealed', openError: null })
    expect(h.open).not.toHaveBeenCalled()
    expect(h.reveal).toHaveBeenCalledOnce()
  })

  it('fails as incomplete when the byte count is short of the asset size', async () => {
    const h = harness()
    const downloader = createUpdateDownloader(h.deps)
    const done = downloader.start()
    h.finish({ ok: true, path: `/downloads/${DMG}`, receivedBytes: SIZE - 1 })

    expect(await done).toMatchObject({ kind: 'failed', reason: 'incomplete' })
    expect(h.open).not.toHaveBeenCalled()
  })

  it('skips the size check for an asset that reports no size', async () => {
    const sizeless: AvailableRelease = { ...RELEASE, assets: [{ ...ASSET, size: 0 }] }
    const h = harness({ release: () => sizeless })
    const downloader = createUpdateDownloader(h.deps)
    const done = downloader.start()
    h.finish({ ok: true, path: `/downloads/${DMG}`, receivedBytes: 5 })

    expect(await done).toMatchObject({ kind: 'ready' })
  })

  it('reports a transport failure with its reason, and can start again', async () => {
    const h = harness()
    const downloader = createUpdateDownloader(h.deps)
    const done = downloader.start()
    h.finish({ ok: false, reason: 'interrupted', detail: 'cancelled' })

    expect(await done).toMatchObject({ kind: 'failed', reason: 'interrupted', detail: 'cancelled', assetName: DMG })

    void downloader.start()
    expect(downloader.state().kind).toBe('downloading')
    expect(h.download).toHaveBeenCalledTimes(2)
  })

  it('resolves failed/unavailable when the transport throws', async () => {
    const downloader = createUpdateDownloader(harness({ download: () => Promise.reject(new Error('boom')) }).deps)

    expect(await downloader.start()).toMatchObject({ kind: 'failed', reason: 'unavailable', detail: 'boom' })
  })

  it('resolves failed/unavailable when the transport throws synchronously', async () => {
    const downloader = createUpdateDownloader(
      harness({
        download: () => {
          throw new Error('sync boom')
        },
      }).deps,
    )

    expect(await downloader.start()).toMatchObject({ kind: 'failed', reason: 'unavailable', detail: 'sync boom' })
  })

  it('does nothing without an available release', async () => {
    const h = harness({ release: () => null })
    const downloader = createUpdateDownloader(h.deps)

    expect(await downloader.start()).toEqual({ kind: 'idle' })
    expect(h.download).not.toHaveBeenCalled()
  })

  it('reports no-asset for a null target, without downloading', async () => {
    const h = harness({ target: null })
    const downloader = createUpdateDownloader(h.deps)

    expect(await downloader.start()).toEqual({ kind: 'no-asset', version: '1.5.0', notesUrl: RELEASE.notesUrl, target: null })
    expect(h.download).not.toHaveBeenCalled()
  })

  it('reports no-asset when the release has no matching installer', async () => {
    const h = harness({ release: () => ({ ...RELEASE, assets: [] }) })
    const downloader = createUpdateDownloader(h.deps)

    expect(await downloader.start()).toMatchObject({ kind: 'no-asset', target: MAC })
  })

  it('does not download a ready version again', async () => {
    const h = harness()
    const downloader = createUpdateDownloader(h.deps)
    const first = downloader.start()
    h.finish(completed)
    await first

    expect(await downloader.start()).toMatchObject({ kind: 'ready' })
    expect(h.download).toHaveBeenCalledOnce()
  })

  describe('open', () => {
    it('leaves any state but ready unchanged', async () => {
      const h = harness()
      const downloader = createUpdateDownloader(h.deps)

      expect(await downloader.open(true)).toEqual({ kind: 'idle' })
      expect(h.reveal).not.toHaveBeenCalled()
      expect(h.open).not.toHaveBeenCalled()
    })

    it('shows the finished file in its folder without downloading again', async () => {
      const h = harness()
      const downloader = createUpdateDownloader(h.deps)
      const first = downloader.start()
      h.finish(completed)
      await first

      expect(await downloader.open(true)).toMatchObject({ kind: 'ready' })
      expect(h.reveal).toHaveBeenCalledWith(`/downloads/${DMG}`)
      expect(h.download).toHaveBeenCalledOnce()
    })

    it('opens the installer again and updates the opened state', async () => {
      const h = harness()
      h.open.mockResolvedValueOnce('no application').mockResolvedValueOnce('')
      const downloader = createUpdateDownloader(h.deps)
      const first = downloader.start()
      h.finish(completed)
      expect(await first).toMatchObject({ opened: 'revealed', openError: 'no application' })

      expect(await downloader.open(false)).toMatchObject({ kind: 'ready', opened: 'opened', openError: null })
      expect(h.open).toHaveBeenCalledTimes(2)
    })
  })
})
