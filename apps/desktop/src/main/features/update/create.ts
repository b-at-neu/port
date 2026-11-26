// Wires the update service and downloader the app holds for its lifetime.
import type { AppContext } from '@/main/app/context'
import { inPlaceSupported, installTargetOf } from '@/main/features/update/assets'
import { createUpdateDownloader } from '@/main/features/update/download'
import { createInPlaceUpdater } from '@/main/features/update/in-place'
import { createUpdateService } from '@/main/features/update/service'
import type { RestartSeams, UpdateDownloader, UpdateService } from '@/types/update'

export function createUpdate(ctx: Pick<AppContext, 'info' | 'updates' | 'githubPublic' | 'clock'>, restart: RestartSeams): { readonly service: UpdateService; readonly downloader: UpdateDownloader } {
  const repo = __PORT_RELEASE_REPO__
  const service = createUpdateService(ctx, { repo })
  const release = () => {
    const current = service.state()
    return current.kind === 'available' ? current.release : null
  }
  const target = installTargetOf(ctx.updates.installHost)
  const fallback = createUpdateDownloader(ctx, { release, target, repo })
  const downloader = inPlaceSupported(target) ? createInPlaceUpdater(ctx, { release, fallback, restart }) : fallback
  return { service, downloader }
}
