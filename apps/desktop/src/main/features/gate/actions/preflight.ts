import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { positiveInt, repoId } from '@/main/app/schemas'
import { gatePreflight as preflight } from '@/main/pipeline/operator/gate'

export const gatePreflight = defineAction({
  name: 'gate.preflight',
  kind: 'query',
  input: z.object({ repoId, number: positiveInt }),
  run: (ctx, input) => preflight(ctx, input),
})
