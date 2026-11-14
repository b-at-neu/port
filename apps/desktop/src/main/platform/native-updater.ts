// The one adapter over electron-updater; constructed only for an in-place target.
import { basename } from 'node:path'
import { autoUpdater } from 'electron-updater'
import type { NativeUpdater } from '@/types/update'

export function createNativeUpdater(): NativeUpdater {
  const listeners: Array<(message: string) => void> = []
  let configured: typeof autoUpdater | null = null

  function updater(): typeof autoUpdater {
    if (configured !== null) return configured
    const instance = autoUpdater
    instance.autoDownload = false
    instance.autoInstallOnAppQuit = false
    instance.allowPrerelease = false
    instance.allowDowngrade = false
    instance.on('error', (error: Error) => {
      for (const listener of listeners) listener(error.message)
    })
    configured = instance
    return instance
  }

  return {
    check: async () => {
      const result = await updater().checkForUpdates()
      if (result === null || !result.isUpdateAvailable) return null
      return { version: result.updateInfo.version, fileName: basename(result.updateInfo.files[0]?.url ?? '') }
    },
    download: async (onProgress) => {
      const instance = updater()
      const listener = (progress: { transferred: number; total: number }): void => onProgress(progress.transferred, progress.total)
      instance.on('download-progress', listener)
      try {
        await instance.downloadUpdate()
      } finally {
        instance.removeListener('download-progress', listener)
      }
    },
    install: () => updater().quitAndInstall(true, true),
    onError: (listener) => {
      listeners.push(listener)
      updater()
    },
  }
}
