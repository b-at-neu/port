import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { sessionKey } from '@/main/app/schemas'
import { resolveSessionClose } from '@/main/features/session/resolve'

export const sessionClose = defineAction({ name: 'session.close', kind: 'mutation', input: z.object({ sessionKey }), run: (ctx, input) => resolveSessionClose(input, ctx.seams.hosting) })
