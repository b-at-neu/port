import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({ accessed: 0, fake: null as unknown }))

vi.mock('electron-updater', () => ({
  get autoUpdater() {
    harness.accessed += 1
    return harness.fake
  },
}))

import { createNativeUpdater } from '@/main/platform/native-updater'

class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowPrerelease = true
  allowDowngrade = true
  checkForUpdates = vi.fn()
  downloadUpdate = vi.fn(() => Promise.resolve([]))
  quitAndInstall = vi.fn()
}

let fake: FakeUpdater

beforeEach(() => {
  fake = new FakeUpdater()
  harness.fake = fake
  harness.accessed = 0
})

describe('createNativeUpdater', () => {
  it('constructs nothing on creation', () => {
    createNativeUpdater()
    expect(harness.accessed).toBe(0)
  })

  it('sets the four flags on the first call', async () => {
    fake.checkForUpdates.mockResolvedValue(null)
    await createNativeUpdater().check()
    expect([fake.autoDownload, fake.autoInstallOnAppQuit, fake.allowPrerelease, fake.allowDowngrade]).toEqual([false, false, false, false])
  })

  it.each([
    ['null', null],
    ['no update available', { isUpdateAvailable: false, updateInfo: { version: '0.2.0', files: [] } }],
  ])('maps %s to null', async (_label, result) => {
    fake.checkForUpdates.mockResolvedValue(result)
    expect(await createNativeUpdater().check()).toBeNull()
  })

  it('maps an available update to its version and file basename', async () => {
    fake.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo: { version: '0.2.0', files: [{ url: 'dir/port-0.2.0-win-x64.exe' }] } })
    expect(await createNativeUpdater().check()).toEqual({ version: '0.2.0', fileName: 'port-0.2.0-win-x64.exe' })
  })

  it('forwards progress and removes its listener on success', async () => {
    const onProgress = vi.fn()
    fake.downloadUpdate.mockImplementation(() => {
      fake.emit('download-progress', { transferred: 4, total: 8 })
      return Promise.resolve([])
    })
    await createNativeUpdater().download(onProgress)
    expect(onProgress).toHaveBeenCalledWith(4, 8)
    expect(fake.listenerCount('download-progress')).toBe(0)
  })

  it('removes its progress listener when the download rejects', async () => {
    fake.downloadUpdate.mockRejectedValue(new Error('boom'))
    await expect(createNativeUpdater().download(vi.fn())).rejects.toThrow('boom')
    expect(fake.listenerCount('download-progress')).toBe(0)
  })

  it('installs silently and relaunches', () => {
    createNativeUpdater().install()
    expect(fake.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('forwards an emitted error to every onError listener', () => {
    const updater = createNativeUpdater()
    const first = vi.fn()
    const second = vi.fn()
    updater.onError(first)
    updater.onError(second)
    fake.emit('error', new Error('feed unreachable'))
    expect(first).toHaveBeenCalledWith('feed unreachable')
    expect(second).toHaveBeenCalledWith('feed unreachable')
  })
})
