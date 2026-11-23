import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { sessionKey } from '@/main/app/schemas'
import { MAX_INVOKE_ARGS_CHARS, resolveSessionInvoke } from '@/main/channels/hosting'

export const sessionInvoke = defineAction({
  name: 'session.invoke',
  kind: 'mutation',
  input: z.object({ sessionKey, name: z.string().min(1), args: z.string().max(MAX_INVOKE_ARGS_CHARS) }),
  run: (ctx, input) => resolveSessionInvoke(input, ctx.seams.hosting),
})
