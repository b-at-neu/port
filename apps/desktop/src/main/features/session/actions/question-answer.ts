import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { sessionKey } from '@/main/app/schemas'
import { resolveSessionQuestionAnswer } from '@/main/channels/hosting'

export const sessionQuestionAnswer = defineAction({
  name: 'session.questionAnswer',
  kind: 'mutation',
  input: z.object({ sessionKey, permissionId: z.string().min(1), answers: z.record(z.string(), z.string().max(2000)) }),
  run: (ctx, input) => resolveSessionQuestionAnswer(input, ctx.seams.hosting),
})
