import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { sessionKey } from '@/main/app/schemas'
import { MAX_TASK_ID_CHARS } from '@/main/features/session/schemas'

export const sessionTaskStop = defineAction({
  name: 'session.taskStop',
  kind: 'mutation',
  input: z.object({ sessionKey, taskId: z.string().min(1).max(MAX_TASK_ID_CHARS) }),
  run: (ctx, input) => ctx.live.hostedStore.stopTask(input.sessionKey, input.taskId),
})
