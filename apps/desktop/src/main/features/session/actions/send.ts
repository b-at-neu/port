import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { sessionKey } from '@/main/app/schemas'
import { resolveSessionSend } from '@/main/channels/hosting'
import { attachments } from '@/main/features/session/schemas'

export const sessionSend = defineAction({
  name: 'session.send',
  kind: 'mutation',
  input: z.object({ sessionKey, text: z.string(), attachments: attachments.optional() }),
  run: (ctx, input) => resolveSessionSend(input, ctx.seams.hosting),
})
