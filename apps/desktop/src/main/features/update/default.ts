// The one place real I/O meets the update seams.
import { app, session, shell } from 'electron'
import { fetchAppReleases } from '@/main/github/app-releases'
import type { GitHubPublicContext } from '@/main/github/context'
import { inPlaceSupported, installTargetOf } from '@/main/features/update/assets'
import { createUpdateDownloader } from '@/main/features/update/download'
import { createInPlaceUpdater } from '@/main/features/update/in-place'
import { createUpdateService } from '@/main/features/update/service'
import { createFileDownloader } from '@/main/platform/download'
import { createNativeUpdater } from '@/main/platform/native-updater'
import type { RestartSeams, UpdateDownloader, UpdateService } from '@/types/update'

export function createDefaultUpdate(ctx: GitHubPublicContext, restart: RestartSeams): { readonly service: UpdateService; readonly downloader: UpdateDownloader } {
  const service = createUpdateService({
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    repo: __PORT_RELEASE_REPO__,
    fetchReleases: (repo) => fetchAppReleases(ctx, repo),
    now: () => new Date(),
  })
  const release = () => {
    const current = service.state()
    return current.kind === 'available' ? current.release : null
  }
  const target = installTargetOf({ platform: process.platform, arch: process.arch, appImage: process.env.APPIMAGE, arm64Translation: app.runningUnderARM64Translation })
  const fallback = createUpdateDownloader({
    release,
    target,
    repo: __PORT_RELEASE_REPO__,
    downloadsDir: () => app.getPath('downloads'),
    download: (request) => createFileDownloader(session.defaultSession)(request),
    open: (path) => shell.openPath(path),
    reveal: (path) => shell.showItemInFolder(path),
    now: () => new Date(),
  })
  const downloader = inPlaceSupported(target)
    ? createInPlaceUpdater({ release, native: createNativeUpdater, fallback, confirmRestart: restart.confirm, cancelRestart: restart.cancel, now: () => new Date() })
    : fallback
  return { service, downloader }
}
