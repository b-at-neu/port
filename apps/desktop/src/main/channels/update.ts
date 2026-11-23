import type { UpdateDownloader, UpdateDownloadState, UpdateService, UpdateState } from '@/types/update'

export function resolveUpdateState(request: unknown, service: UpdateService): UpdateState {
  if (request !== undefined) throw new Error("'update:state' takes no payload")
  return service.state()
}

export function resolveUpdateCheck(request: unknown, service: UpdateService): Promise<UpdateState> {
  if (request !== undefined) throw new Error("'update:check' takes no payload")
  return service.check('manual')
}

export function resolveUpdateDownload(request: unknown, downloader: UpdateDownloader): Promise<UpdateDownloadState> {
  if (request !== undefined) throw new Error("'update:download' takes no payload")
  return downloader.start()
}

export function resolveUpdateDownloadState(request: unknown, downloader: UpdateDownloader): UpdateDownloadState {
  if (request !== undefined) throw new Error("'update:download:state' takes no payload")
  return downloader.state()
}

export function resolveUpdateOpen(request: unknown, downloader: UpdateDownloader): Promise<UpdateDownloadState> {
  if (typeof request !== 'object' || request === null || Object.keys(request).length !== 1 || !('reveal' in request) || typeof request.reveal !== 'boolean') {
    throw new Error("'update:open' takes exactly { reveal: boolean }")
  }
  return downloader.open(request.reveal)
}
