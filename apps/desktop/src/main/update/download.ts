// Downloads the available release's installer for this install and hands it to the user.
import { join } from 'node:path'
import { openModeOf, pickAsset } from '@/main/update/assets'
import type { AvailableRelease, FileDownload, InstallTarget, ReleaseAsset, UpdateDownloader, UpdateDownloadState } from '@/types/update'

export interface UpdateDownloaderDeps {
  readonly release: () => AvailableRelease | null
  readonly target: InstallTarget | null
  /** `owner/name` of the repository whose release downloads are trusted. */
  readonly repo: string
  readonly downloadsDir: () => string
  readonly download: FileDownload
  /** Resolves with an error string, empty on success, like Electron's `shell.openPath`. */
  readonly open: (path: string) => Promise<string>
  readonly reveal: (path: string) => void
  readonly now: () => Date
}

type Ready = Extract<UpdateDownloadState, { kind: 'ready' }>

/** Holds one state; every failure becomes a `failed` value, so `start` never rejects. */
export function createUpdateDownloader(deps: UpdateDownloaderDeps): UpdateDownloader {
  let state: UpdateDownloadState = { kind: 'idle' }
  let inFlight: Promise<UpdateDownloadState> | null = null

  function fail(release: AvailableRelease, assetName: string, reason: 'interrupted' | 'incomplete' | 'unavailable', detail: string): UpdateDownloadState {
    console.warn('[update] download failed', reason)
    return { kind: 'failed', version: release.version, notesUrl: release.notesUrl, assetName, reason, detail, failedAt: deps.now().toISOString() }
  }

  async function handOff(target: InstallTarget, path: string): Promise<Pick<Ready, 'opened' | 'openError'>> {
    if (openModeOf(target) === 'reveal') {
      deps.reveal(path)
      return { opened: 'revealed', openError: null }
    }
    const openError = await deps.open(path)
    if (openError === '') return { opened: 'opened', openError: null }
    deps.reveal(path)
    return { opened: 'revealed', openError }
  }

  async function run(release: AvailableRelease, target: InstallTarget, asset: ReleaseAsset): Promise<UpdateDownloadState> {
    const startedAt = deps.now().toISOString()
    const base = { version: release.version, notesUrl: release.notesUrl, assetName: asset.name }
    try {
      const result = await deps.download({
        url: asset.url,
        savePath: join(deps.downloadsDir(), asset.name),
        onProgress: (received, total) => {
          state = { kind: 'downloading', ...base, receivedBytes: received, totalBytes: total > 0 ? total : asset.size, startedAt }
        },
      })
      if (!result.ok) return fail(release, asset.name, result.reason, result.detail)
      if (asset.size > 0 && result.receivedBytes !== asset.size) {
        return fail(release, asset.name, 'incomplete', `received ${result.receivedBytes} of ${asset.size} bytes`)
      }
      const handed = await handOff(target, result.path)
      return { kind: 'ready', ...base, path: result.path, package: target.package, ...handed, finishedAt: deps.now().toISOString() }
    } catch (error) {
      return fail(release, asset.name, 'unavailable', error instanceof Error ? error.message : String(error))
    }
  }

  function start(): Promise<UpdateDownloadState> {
    if (inFlight !== null) return inFlight
    const release = deps.release()
    if (release === null) return Promise.resolve(state)
    if (state.kind === 'ready' && state.version === release.version) return Promise.resolve(state)
    const asset = deps.target === null ? null : pickAsset(release, deps.target, deps.repo)
    if (deps.target === null || asset === null) {
      state = { kind: 'no-asset', version: release.version, notesUrl: release.notesUrl, target: deps.target }
      return Promise.resolve(state)
    }
    state = { kind: 'downloading', version: release.version, notesUrl: release.notesUrl, assetName: asset.name, receivedBytes: 0, totalBytes: asset.size, startedAt: deps.now().toISOString() }
    const pending = run(release, deps.target, asset).then((next) => {
      state = next
      inFlight = null
      return next
    })
    inFlight = pending
    return pending
  }

  async function open(reveal: boolean): Promise<UpdateDownloadState> {
    if (state.kind !== 'ready' || deps.target === null) return state
    const { path } = state
    try {
      if (reveal) {
        deps.reveal(path)
      } else {
        const handed = await handOff(deps.target, path)
        if (state.kind === 'ready') state = { ...state, ...handed }
      }
    } catch (error) {
      console.warn('[update] open failed', error instanceof Error ? error.message : String(error))
    }
    return state
  }

  return { state: () => state, start, open }
}
