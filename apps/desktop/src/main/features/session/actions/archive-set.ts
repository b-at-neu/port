import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { resolveSessionArchiveSet } from '@/main/features/session/resolve'

export const sessionArchiveSet = defineAction({
  name: 'session.archiveSet',
  kind: 'mutation',
  input: z.object({ sessionId: z.string(), archived: z.boolean() }),
  run: (ctx, input) => ctx.live.sessionMenu.withRefresh(resolveSessionArchiveSet(input, ctx.seams.hosting)),
})
