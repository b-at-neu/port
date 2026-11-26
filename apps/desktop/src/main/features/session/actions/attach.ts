import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { sessionKey } from '@/main/app/schemas'

export const sessionAttach = defineAction({ name: 'session.attach', kind: 'mutation', input: z.object({ sessionKey }), run: (ctx, input) => ctx.live.hostedStore.attach(input.sessionKey) })
