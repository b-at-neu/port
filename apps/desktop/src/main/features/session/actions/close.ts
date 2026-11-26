import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { sessionKey } from '@/main/app/schemas'

export const sessionClose = defineAction({ name: 'session.close', kind: 'mutation', input: z.object({ sessionKey }), run: (ctx, input) => ctx.live.hostedStore.close(input.sessionKey) })
