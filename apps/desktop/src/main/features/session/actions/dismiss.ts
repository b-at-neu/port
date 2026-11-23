import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { sessionKey } from '@/main/app/schemas'
import { resolveSessionDismiss } from '@/main/features/session/resolve'

export const sessionDismiss = defineAction({
  name: 'session.dismiss',
  kind: 'mutation',
  input: z.object({ sessionKey, worktree: z.enum(['keep', 'remove', 'force']) }),
  run: (ctx, input) => ctx.live.sessionMenu.withRefresh(resolveSessionDismiss(input, ctx.seams.hosting)),
})
