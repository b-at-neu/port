import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { sessionKey } from '@/main/app/schemas'
import { resolveSessionInterrupt } from '@/main/channels/hosting'

export const sessionInterrupt = defineAction({ name: 'session.interrupt', kind: 'mutation', input: z.object({ sessionKey }), run: (ctx, input) => resolveSessionInterrupt(input, ctx.seams.hosting) })
