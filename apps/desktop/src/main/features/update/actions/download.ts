import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'
import { resolveUpdateDownload } from '@/main/features/update/resolve'

export const updateDownload = defineAction({ name: 'update.download', kind: 'mutation', input: noInput, run: (ctx, input) => resolveUpdateDownload(input, ctx.live.update.downloader) })
