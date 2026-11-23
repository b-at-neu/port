import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { resolveSessionPinSet } from '@/main/channels/hosting'

export const sessionPinSet = defineAction({
  name: 'session.pinSet',
  kind: 'mutation',
  input: z.object({ sessionId: z.string(), pinned: z.boolean() }),
  run: (ctx, input) => ctx.live.sessionMenu.withRefresh(resolveSessionPinSet(input, ctx.seams.hosting)),
})
