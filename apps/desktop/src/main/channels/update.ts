import type { IpcMap } from '@/types/ipc'
import type { UpdateDownloader, UpdateDownloadState, UpdateService, UpdateState } from '@/types/update'

type UpdateChannel = 'update:state' | 'update:check' | 'update:download' | 'update:download:state' | 'update:open'

interface RegisterUpdateChannel {
  <C extends UpdateChannel>(channel: C, handler: (event: unknown, request: IpcMap[C]['request']) => IpcMap[C]['response'] | Promise<IpcMap[C]['response']>): void
}

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

export function registerUpdateChannels(register: RegisterUpdateChannel, update: { readonly service: UpdateService; readonly downloader: UpdateDownloader }): void {
  register('update:state', (_event, request) => resolveUpdateState(request, update.service))
  register('update:check', (_event, request) => resolveUpdateCheck(request, update.service))
  register('update:download', (_event, request) => resolveUpdateDownload(request, update.downloader))
  register('update:download:state', (_event, request) => resolveUpdateDownloadState(request, update.downloader))
  register('update:open', (_event, request) => resolveUpdateOpen(request, update.downloader))
}
