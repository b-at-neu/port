import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createUpdateDownloader } from '@/main/features/update/download'
import type { UpdateDownloaderParams } from '@/main/features/update/download'
import type { PlatformUpdates } from '@/types/platform'
import type { AvailableRelease, FileDownloadResult, InstallTarget } from '@/types/update'
import { createFakeClock, fakeUpdates } from '../../../support/fake-platform'

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

function harness(overrides: Partial<UpdateDownloaderParams> = {}, platform: Partial<PlatformUpdates> = {}) {
  let finish: (result: FileDownloadResult) => void = () => undefined
  const updates = fakeUpdates({
    downloadsDir: () => '/downloads',
    download: () =>
      new Promise<FileDownloadResult>((resolve) => {
        finish = resolve
      }),
    ...platform,
  })
  const params: UpdateDownloaderParams = { release: () => RELEASE, target: MAC, repo: REPO, ...overrides }
  const ctx = { updates, clock: createFakeClock('2026-05-01T12:00:00Z') }
  return { downloader: createUpdateDownloader(ctx, params), updates, requests: updates.downloads, finish: (result: FileDownloadResult) => finish(result) }
}

const SAVED = join('/downloads', DMG)
const completed: FileDownloadResult = { ok: true, path: SAVED, receivedBytes: SIZE }

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('createUpdateDownloader', () => {
  it('is downloading synchronously after start, with the asset size as the total', () => {
    const h = harness()

    void h.downloader.start()

    expect(h.downloader.state()).toMatchObject({ kind: 'downloading', version: '1.5.0', assetName: DMG, receivedBytes: 0, totalBytes: SIZE, startedAt: '2026-05-01T12:00:00.000Z' })
    expect(h.requests[0]).toMatchObject({ url: ASSET.url, savePath: SAVED })
  })

  it('tracks progress and keeps the asset size when the transport reports no total', () => {
    const h = harness()
    void h.downloader.start()

    h.requests[0]?.onProgress(400, 0)
    expect(h.downloader.state()).toMatchObject({ kind: 'downloading', receivedBytes: 400, totalBytes: SIZE })

    h.requests[0]?.onProgress(600, 1200)
    expect(h.downloader.state()).toMatchObject({ receivedBytes: 600, totalBytes: 1200 })
  })

  it('joins a download in flight rather than starting a second one', async () => {
    const h = harness()

    const first = h.downloader.start()
    const second = h.downloader.start()
    h.finish(completed)

    expect(await first).toBe(await second)
    expect(h.requests).toHaveLength(1)
  })

  it('opens the installer once it completes', async () => {
    const h = harness()
    const done = h.downloader.start()
    h.finish(completed)

    expect(await done).toMatchObject({ kind: 'ready', assetName: DMG, path: SAVED, package: 'dmg', opened: 'opened', openError: null })
    expect(h.updates.opened).toEqual([SAVED])
    expect(h.updates.revealed).toEqual([])
  })

  it('reveals the file and records the error when opening fails', async () => {
    const h = harness({}, { open: () => Promise.resolve('no application') })
    const done = h.downloader.start()
    h.finish(completed)

    expect(await done).toMatchObject({ kind: 'ready', opened: 'revealed', openError: 'no application' })
    expect(h.updates.revealed).toEqual([SAVED])
  })

  it('only reveals an AppImage', async () => {
    const h = harness({ target: APPIMAGE, release: () => APPIMAGE_RELEASE })
    const done = h.downloader.start()
    h.finish({ ok: true, path: '/downloads/port-1.5.0-linux-x86_64.AppImage', receivedBytes: SIZE })

    expect(await done).toMatchObject({ kind: 'ready', package: 'appimage', opened: 'revealed', openError: null })
    expect(h.updates.opened).toEqual([])
    expect(h.updates.revealed).toHaveLength(1)
  })

  it('fails as incomplete when the byte count is short of the asset size', async () => {
    const h = harness()
    const done = h.downloader.start()
    h.finish({ ok: true, path: `/downloads/${DMG}`, receivedBytes: SIZE - 1 })

    expect(await done).toMatchObject({ kind: 'failed', reason: 'incomplete' })
    expect(h.updates.opened).toEqual([])
  })

  it('skips the size check for an asset that reports no size', async () => {
    const sizeless: AvailableRelease = { ...RELEASE, assets: [{ ...ASSET, size: 0 }] }
    const h = harness({ release: () => sizeless })
    const done = h.downloader.start()
    h.finish({ ok: true, path: `/downloads/${DMG}`, receivedBytes: 5 })

    expect(await done).toMatchObject({ kind: 'ready' })
  })

  it('reports a transport failure with its reason, and can start again', async () => {
    const h = harness()
    const done = h.downloader.start()
    h.finish({ ok: false, reason: 'interrupted', detail: 'cancelled' })

    expect(await done).toMatchObject({ kind: 'failed', reason: 'interrupted', detail: 'cancelled', assetName: DMG, failedAt: '2026-05-01T12:00:00.000Z' })

    void h.downloader.start()
    expect(h.downloader.state().kind).toBe('downloading')
    expect(h.requests).toHaveLength(2)
  })

  it('resolves failed/unavailable when the transport throws', async () => {
    const h = harness({}, { download: () => Promise.reject(new Error('boom')) })

    expect(await h.downloader.start()).toMatchObject({ kind: 'failed', reason: 'unavailable', detail: 'boom' })
  })

  it('resolves failed/unavailable when the transport throws synchronously', async () => {
    const h = harness(
      {},
      {
        download: () => {
          throw new Error('sync boom')
        },
      },
    )

    expect(await h.downloader.start()).toMatchObject({ kind: 'failed', reason: 'unavailable', detail: 'sync boom' })
  })

  it('does nothing without an available release', async () => {
    const h = harness({ release: () => null })

    expect(await h.downloader.start()).toEqual({ kind: 'idle' })
    expect(h.requests).toHaveLength(0)
  })

  it('reports no-asset for a null target, without downloading', async () => {
    const h = harness({ target: null })

    expect(await h.downloader.start()).toEqual({ kind: 'no-asset', version: '1.5.0', notesUrl: RELEASE.notesUrl, target: null })
    expect(h.requests).toHaveLength(0)
  })

  it('reports no-asset when the release has no matching installer', async () => {
    const h = harness({ release: () => ({ ...RELEASE, assets: [] }) })

    expect(await h.downloader.start()).toMatchObject({ kind: 'no-asset', target: MAC })
  })

  it('does not download a ready version again', async () => {
    const h = harness()
    const first = h.downloader.start()
    h.finish(completed)
    await first

    expect(await h.downloader.start()).toMatchObject({ kind: 'ready' })
    expect(h.requests).toHaveLength(1)
  })

  describe('open', () => {
    it('leaves any state but ready unchanged', async () => {
      const h = harness()

      expect(await h.downloader.open(true)).toEqual({ kind: 'idle' })
      expect(h.updates.revealed).toEqual([])
      expect(h.updates.opened).toEqual([])
    })

    it('shows the finished file in its folder without downloading again', async () => {
      const h = harness()
      const first = h.downloader.start()
      h.finish(completed)
      await first

      expect(await h.downloader.open(true)).toMatchObject({ kind: 'ready' })
      expect(h.updates.revealed).toEqual([SAVED])
      expect(h.requests).toHaveLength(1)
    })

    it('opens the installer again and updates the opened state', async () => {
      const results = ['no application', '']
      const h = harness({}, { open: () => Promise.resolve(results.shift() ?? '') })
      const first = h.downloader.start()
      h.finish(completed)
      expect(await first).toMatchObject({ opened: 'revealed', openError: 'no application' })

      expect(await h.downloader.open(false)).toMatchObject({ kind: 'ready', opened: 'opened', openError: null })
      expect(h.updates.opened).toHaveLength(2)
    })
  })
})
