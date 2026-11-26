import { z } from 'zod'
import { defineAction } from '@/main/app/define'

export const sessionArchiveSet = defineAction({
  name: 'session.archiveSet',
  kind: 'mutation',
  input: z.object({ sessionId: z.string(), archived: z.boolean() }),
  run: (ctx, input) => ctx.live.sessionMenu.withRefresh(ctx.live.hostedStore.setMark('archived', input.sessionId, input.archived)),
})
