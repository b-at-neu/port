import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { positiveInt, repoId } from '@/main/app/schemas'
import { resolveGatePreflight } from '@/main/channels/gate'

export const gatePreflight = defineAction({
  name: 'gate.preflight',
  kind: 'query',
  input: z.object({ repoId, number: positiveInt }),
  run: (ctx, input) => resolveGatePreflight(ctx.repos.deps, input, ctx.seams.gate),
})
