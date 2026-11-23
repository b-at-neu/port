import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'
import { resolveUpdateDownloadState } from '@/main/features/update/resolve'

export const updateDownloadState = defineAction({ name: 'update.downloadState', kind: 'query', input: noInput, run: (ctx, input) => resolveUpdateDownloadState(input, ctx.live.update.downloader) })
