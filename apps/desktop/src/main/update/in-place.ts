// Updates in place through the native updater, and falls back to the downloader on any failure.
import type { AvailableRelease, NativeUpdater, UpdateDownloader, UpdateDownloadState } from '@/types/update'

export interface InPlaceUpdaterDeps {
  readonly release: () => AvailableRelease | null
  /** Called lazily, at most once. */
  readonly native: () => NativeUpdater
  readonly fallback: UpdateDownloader
  /** Resolves false when the operator declines to quit. */
  readonly confirmRestart: () => Promise<boolean>
  readonly cancelRestart: () => void
  readonly now: () => Date
}

export function createInPlaceUpdater(deps: InPlaceUpdaterDeps): UpdateDownloader {
  let own: UpdateDownloadState = { kind: 'idle' }
  let fallbackVersion: string | null = null
  let inFlight: Promise<UpdateDownloadState> | null = null
  let nativeUpdater: NativeUpdater | null = null

  function native(): NativeUpdater {
    if (nativeUpdater !== null) return nativeUpdater
    const created = deps.native()
    created.onError((message) => {
      if (own.kind !== 'restarting') return
      const release = deps.release()
      deps.cancelRestart()
      if (release !== null) void fallBack(release, message)
    })
    nativeUpdater = created
    return created
  }

  function state(): UpdateDownloadState {
    return deps.release()?.version === fallbackVersion && fallbackVersion !== null ? deps.fallback.state() : own
  }

  function fallBack(release: AvailableRelease, reason: string): Promise<UpdateDownloadState> {
    console.warn('[update] in-place update failed, falling back', reason)
    fallbackVersion = release.version
    own = { kind: 'idle' }
    return deps.fallback.start()
  }

  async function restart(release: AvailableRelease): Promise<UpdateDownloadState> {
    if (!(await deps.confirmRestart())) {
      own = { kind: 'restart-pending', version: release.version, notesUrl: release.notesUrl, finishedAt: deps.now().toISOString() }
      return own
    }
    own = { kind: 'restarting', version: release.version, notesUrl: release.notesUrl, startedAt: deps.now().toISOString() }
    try {
      native().install()
    } catch (error) {
      deps.cancelRestart()
      return fallBack(release, error instanceof Error ? error.message : String(error))
    }
    return own
  }

  async function run(release: AvailableRelease, downloading: Extract<UpdateDownloadState, { kind: 'downloading' }>): Promise<UpdateDownloadState> {
    try {
      const updater = native()
      const info = await updater.check()
      if (info === null || info.version !== release.version) return await fallBack(release, 'no matching update')
      const base = { ...downloading, assetName: info.fileName }
      own = base
      await updater.download((transferred, total) => {
        own = { ...base, receivedBytes: transferred, totalBytes: total }
      })
      return await restart(release)
    } catch (error) {
      return fallBack(release, error instanceof Error ? error.message : String(error))
    }
  }

  function settle(pending: Promise<UpdateDownloadState>): Promise<UpdateDownloadState> {
    const tracked = pending.then((next) => {
      inFlight = null
      return next
    })
    inFlight = tracked
    return tracked
  }

  function start(): Promise<UpdateDownloadState> {
    if (inFlight !== null) return inFlight
    const release = deps.release()
    if (release === null) return Promise.resolve(state())
    if (fallbackVersion === release.version) return deps.fallback.start()
    if (own.kind === 'restarting' && own.version === release.version) return Promise.resolve(own)
    if (own.kind === 'restart-pending' && own.version === release.version) return settle(restart(release))
    const downloading: Extract<UpdateDownloadState, { kind: 'downloading' }> = {
      kind: 'downloading',
      version: release.version,
      notesUrl: release.notesUrl,
      assetName: '',
      receivedBytes: 0,
      totalBytes: 0,
      startedAt: deps.now().toISOString(),
    }
    own = downloading
    return settle(run(release, downloading))
  }

  return { state, start, open: (reveal) => deps.fallback.open(reveal) }
}
