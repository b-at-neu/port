// Downloads the available release's installer for this install and hands it to the user.
import type { AppContext } from '@/main/app/context'
import { openModeOf, pickAsset } from '@/main/features/update/assets'
import { pathOps } from '@/main/platform/paths'
import type { AvailableRelease, InstallTarget, ReleaseAsset, UpdateDownloader, UpdateDownloadState } from '@/types/update'

export interface UpdateDownloaderParams {
  readonly release: () => AvailableRelease | null
  readonly target: InstallTarget | null
  /** `owner/name` of the repository whose release downloads are trusted. */
  readonly repo: string
}

type Ready = Extract<UpdateDownloadState, { kind: 'ready' }>

/** Holds one state; every failure becomes a `failed` value, so `start` never rejects. */
export function createUpdateDownloader(ctx: Pick<AppContext, 'updates' | 'clock'>, params: UpdateDownloaderParams): UpdateDownloader {
  const { release: currentRelease, target, repo } = params
  let state: UpdateDownloadState = { kind: 'idle' }
  let inFlight: Promise<UpdateDownloadState> | null = null

  function fail(release: AvailableRelease, assetName: string, reason: 'interrupted' | 'incomplete' | 'unavailable', detail: string): UpdateDownloadState {
    console.warn('[update] download failed', reason)
    return { kind: 'failed', version: release.version, notesUrl: release.notesUrl, assetName, reason, detail, failedAt: ctx.clock.now().toISOString() }
  }

  async function handOff(installTarget: InstallTarget, path: string): Promise<Pick<Ready, 'opened' | 'openError'>> {
    if (openModeOf(installTarget) === 'reveal') {
      ctx.updates.reveal(path)
      return { opened: 'revealed', openError: null }
    }
    const openError = await ctx.updates.open(path)
    if (openError === '') return { opened: 'opened', openError: null }
    ctx.updates.reveal(path)
    return { opened: 'revealed', openError }
  }

  async function run(release: AvailableRelease, installTarget: InstallTarget, asset: ReleaseAsset): Promise<UpdateDownloadState> {
    const startedAt = ctx.clock.now().toISOString()
    const base = { version: release.version, notesUrl: release.notesUrl, assetName: asset.name }
    try {
      const result = await ctx.updates.download({
        url: asset.url,
        savePath: pathOps.join(ctx.updates.downloadsDir(), asset.name),
        onProgress: (received, total) => {
          state = { kind: 'downloading', ...base, receivedBytes: received, totalBytes: total > 0 ? total : asset.size, startedAt }
        },
      })
      if (!result.ok) return fail(release, asset.name, result.reason, result.detail)
      if (asset.size > 0 && result.receivedBytes !== asset.size) {
        return fail(release, asset.name, 'incomplete', `received ${result.receivedBytes} of ${asset.size} bytes`)
      }
      const handed = await handOff(installTarget, result.path)
      return { kind: 'ready', ...base, path: result.path, package: installTarget.package, ...handed, finishedAt: ctx.clock.now().toISOString() }
    } catch (error) {
      return fail(release, asset.name, 'unavailable', error instanceof Error ? error.message : String(error))
    }
  }

  function start(): Promise<UpdateDownloadState> {
    if (inFlight !== null) return inFlight
    const release = currentRelease()
    if (release === null) return Promise.resolve(state)
    if (state.kind === 'ready' && state.version === release.version) return Promise.resolve(state)
    const asset = target === null ? null : pickAsset(release, target, repo)
    if (target === null || asset === null) {
      state = { kind: 'no-asset', version: release.version, notesUrl: release.notesUrl, target }
      return Promise.resolve(state)
    }
    state = { kind: 'downloading', version: release.version, notesUrl: release.notesUrl, assetName: asset.name, receivedBytes: 0, totalBytes: asset.size, startedAt: ctx.clock.now().toISOString() }
    const pending = run(release, target, asset).then((next) => {
      state = next
      inFlight = null
      return next
    })
    inFlight = pending
    return pending
  }

  async function open(reveal: boolean): Promise<UpdateDownloadState> {
    if (state.kind !== 'ready' || target === null) return state
    const { path } = state
    try {
      if (reveal) {
        ctx.updates.reveal(path)
      } else {
        const handed = await handOff(target, path)
        if (state.kind === 'ready') state = { ...state, ...handed }
      }
    } catch (error) {
      console.warn('[update] open failed', error instanceof Error ? error.message : String(error))
    }
    return state
  }

  return { state: () => state, start, open }
}
