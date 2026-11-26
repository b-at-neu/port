import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { sessionKey } from '@/main/app/schemas'

export const sessionInterrupt = defineAction({ name: 'session.interrupt', kind: 'mutation', input: z.object({ sessionKey }), run: (ctx, input) => ctx.live.hostedStore.interrupt(input.sessionKey) })
