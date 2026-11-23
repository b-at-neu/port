import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { resolveSessionRestoreDiscard } from '@/main/channels/hosting'

export const sessionRestoreDiscard = defineAction({
  name: 'session.restoreDiscard',
  kind: 'mutation',
  input: z.object({ restoreId: z.string().min(1).nullable() }),
  run: (ctx, input) => resolveSessionRestoreDiscard(input, ctx.seams.hosting),
})
