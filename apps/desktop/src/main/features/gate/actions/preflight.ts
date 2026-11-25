import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { positiveInt, repoId } from '@/main/app/schemas'
import { resolveGatePreflight } from '@/main/features/gate/resolve'

export const gatePreflight = defineAction({
  name: 'gate.preflight',
  kind: 'query',
  input: z.object({ repoId, number: positiveInt }),
  run: (ctx, input) => resolveGatePreflight(input, ctx.seams.gate),
})
