// Streams one file to disk through Electron's DownloadItem; the only binary download in main.
import type { DownloadItem, Session } from 'electron'
import type { FileDownload } from '@/types/update'

export interface FileDownloaderOptions {
  readonly startTimeoutMs?: number
}

const DEFAULT_START_TIMEOUT_MS = 30_000

/** Claims only the item for its own URL, so any other download keeps Electron's default behaviour. */
export function createFileDownloader(session: Session, options: FileDownloaderOptions = {}): FileDownload {
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
  return ({ url, savePath, onProgress }) =>
    new Promise((resolve) => {
      const neverStarted = AbortSignal.timeout(startTimeoutMs)
      const giveUp = (): void => {
        session.removeListener('will-download', claim)
        resolve({ ok: false, reason: 'interrupted', detail: 'download never started' })
      }
      const claim = (_event: unknown, item: DownloadItem): void => {
        if (item.getURLChain()[0] !== url) return
        neverStarted.removeEventListener('abort', giveUp)
        session.removeListener('will-download', claim)
        item.setSavePath(savePath)
        item.on('updated', () => onProgress(item.getReceivedBytes(), item.getTotalBytes()))
        item.on('done', (_doneEvent, state) => {
          if (state === 'completed') resolve({ ok: true, path: savePath, receivedBytes: item.getReceivedBytes() })
          else resolve({ ok: false, reason: 'interrupted', detail: state })
        })
      }
      neverStarted.addEventListener('abort', giveUp, { once: true })
      session.on('will-download', claim)
      session.downloadURL(url)
    })
}
