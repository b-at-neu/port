import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { positiveInt, repoId } from '@/main/app/schemas'
import { refreshAfterWrite } from '@/main/features/board'
import { gateAnswer as answer } from '@/main/pipeline/operator/gate'
import { GATE_DECISIONS } from '@/types/gate'

const input = z
  .object({ repoId, number: positiveInt, decision: z.enum(GATE_DECISIONS), feedback: z.string().nullable(), skipComment: z.boolean() })
  .refine((value) => value.decision !== 'request-changes' || value.skipComment || (value.feedback !== null && value.feedback.trim() !== ''), {
    path: ['feedback'],
    message: "'feedback' is required when requesting changes without skipping the comment",
  })

export const gateAnswer = defineAction({
  name: 'gate.answer',
  kind: 'mutation',
  input,
  run: async (ctx, request) => {
    const result = await answer(ctx, { ...request, auditDir: ctx.paths.userData, scratchDir: ctx.paths.temp })
    if (result.kind === 'answered' && result.labels.kind === 'applied') await refreshAfterWrite(ctx, "'gate:answer'", request.repoId)
    return result
  },
})
