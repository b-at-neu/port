import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { sessionKey } from '@/main/app/schemas'
import { planDecision } from '@/main/features/session/schemas'

export const sessionPlanAnswer = defineAction({
  name: 'session.planAnswer',
  kind: 'mutation',
  input: z.object({ sessionKey, permissionId: z.string().min(1), decision: planDecision }),
  run: (ctx, input) => ctx.live.hostedStore.answerPlan(input.sessionKey, input.permissionId, input.decision),
})
