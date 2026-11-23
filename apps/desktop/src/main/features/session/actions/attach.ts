import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { sessionKey } from '@/main/app/schemas'
import { resolveSessionAttach } from '@/main/channels/hosting'

export const sessionAttach = defineAction({ name: 'session.attach', kind: 'mutation', input: z.object({ sessionKey }), run: (ctx, input) => resolveSessionAttach(input, ctx.seams.hosting) })
