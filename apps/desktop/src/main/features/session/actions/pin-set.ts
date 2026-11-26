import { z } from 'zod'
import { defineAction } from '@/main/app/define'

export const sessionPinSet = defineAction({
  name: 'session.pinSet',
  kind: 'mutation',
  input: z.object({ sessionId: z.string(), pinned: z.boolean() }),
  run: (ctx, input) => ctx.live.sessionMenu.withRefresh(ctx.live.hostedStore.setMark('pinned', input.sessionId, input.pinned)),
})
