import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { sessionKey } from '@/main/app/schemas'
import { resolveSessionFiles } from '@/main/channels/hosting'

export const sessionFiles = defineAction({ name: 'session.files', kind: 'query', input: z.object({ sessionKey }), run: (ctx, input) => resolveSessionFiles(input, ctx.seams.hosting) })
