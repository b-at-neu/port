import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { resolveSessionRestore } from '@/main/features/session/resolve'

export const sessionRestore = defineAction({
  name: 'session.restore',
  kind: 'mutation',
  input: z.object({ restoreId: z.string().min(1) }),
  run: (ctx, input) => resolveSessionRestore(ctx.repos.deps, input, ctx.seams.hosting),
})
