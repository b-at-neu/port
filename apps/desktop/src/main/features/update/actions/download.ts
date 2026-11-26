import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'

export const updateDownload = defineAction({ name: 'update.download', kind: 'mutation', input: noInput, run: (ctx) => ctx.live.update.downloader.start() })
