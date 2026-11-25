import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { resolveUpdateOpen } from '@/main/features/update/resolve'

export const updateOpen = defineAction({ name: 'update.open', kind: 'mutation', input: z.strictObject({ reveal: z.boolean() }), run: (ctx, input) => resolveUpdateOpen(input, ctx.live.update.downloader) })
