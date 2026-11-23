import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { sessionKey } from '@/main/app/schemas'
import { resolveSessionRename } from '@/main/channels/hosting'

export const sessionRename = defineAction({
  name: 'session.rename',
  kind: 'mutation',
  input: z.object({ sessionKey, title: z.string() }),
  run: (ctx, input) => resolveSessionRename(input, ctx.seams.hosting),
})
