import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { sessionKey } from '@/main/app/schemas'
import { PERMISSION_DECISIONS } from '@/types/hosting'

export const sessionPermissionAnswer = defineAction({
  name: 'session.permissionAnswer',
  kind: 'mutation',
  input: z
    .object({ sessionKey, permissionId: z.string().min(1), decision: z.enum(PERMISSION_DECISIONS), message: z.string().min(1).max(2000).nullable() })
    .refine((value) => value.message === null || value.decision === 'deny', { message: "'message' must be null unless the decision is 'deny'" }),
  run: (ctx, input) => ctx.live.hostedStore.answerPermission(input.sessionKey, input.permissionId, input.decision, input.message),
})
