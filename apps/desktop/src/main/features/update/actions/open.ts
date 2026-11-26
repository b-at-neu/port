import { z } from 'zod'
import { defineAction } from '@/main/app/define'

export const updateOpen = defineAction({ name: 'update.open', kind: 'mutation', input: z.strictObject({ reveal: z.boolean() }), run: (ctx, input) => ctx.live.update.downloader.open(input.reveal) })
