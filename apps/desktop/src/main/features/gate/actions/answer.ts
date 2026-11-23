import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { positiveInt, repoId } from '@/main/app/schemas'
import { resolveGateAnswer } from '@/main/channels/gate'
import { GATE_DECISIONS } from '@/types/gate'

export const gateAnswer = defineAction({
  name: 'gate.answer',
  kind: 'mutation',
  input: z.object({ repoId, number: positiveInt, decision: z.enum(GATE_DECISIONS), feedback: z.string().nullable(), skipComment: z.boolean() }),
  run: (ctx, input) => resolveGateAnswer(ctx.repos.deps, input, ctx.paths.userData, ctx.paths.temp, ctx.seams.gate),
})
