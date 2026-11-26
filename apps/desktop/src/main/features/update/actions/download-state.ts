import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'

export const updateDownloadState = defineAction({ name: 'update.downloadState', kind: 'query', input: noInput, run: (ctx) => ctx.live.update.downloader.state() })
