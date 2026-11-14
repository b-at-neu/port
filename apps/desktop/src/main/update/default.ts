// The one place real I/O meets the update seams.
import { app, session, shell } from 'electron'
import { fetchAppReleases } from '@/main/github/app-releases'
import { installTargetOf } from '@/main/update/assets'
import { createUpdateDownloader } from '@/main/update/download'
import { createUpdateService } from '@/main/update/service'
import { createFileDownloader } from '@/main/platform/download'
import type { UpdateDownloader, UpdateService } from '@/types/update'

export function createDefaultUpdate(): { readonly service: UpdateService; readonly downloader: UpdateDownloader } {
  const service = createUpdateService({
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    repo: __PORT_RELEASE_REPO__,
    fetchReleases: (repo) => fetchAppReleases(repo),
    now: () => new Date(),
  })
  const downloader = createUpdateDownloader({
    release: () => {
      const current = service.state()
      return current.kind === 'available' ? current.release : null
    },
    target: installTargetOf({ platform: process.platform, arch: process.arch, appImage: process.env.APPIMAGE, arm64Translation: app.runningUnderARM64Translation }),
    repo: __PORT_RELEASE_REPO__,
    downloadsDir: () => app.getPath('downloads'),
    download: (request) => createFileDownloader(session.defaultSession)(request),
    open: (path) => shell.openPath(path),
    reveal: (path) => shell.showItemInFolder(path),
    now: () => new Date(),
  })
  return { service, downloader }
}
