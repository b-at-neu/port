import { z } from 'zod'
import { defineAction } from '@/main/app/define'

export const sessionRestoreDiscard = defineAction({
  name: 'session.restoreDiscard',
  kind: 'mutation',
  input: z.object({ restoreId: z.string().min(1).nullable() }),
  run: (ctx, input) => ctx.live.hostedStore.discardRestorable(input.restoreId),
})
