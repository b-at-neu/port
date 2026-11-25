import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { positiveInt, repoId } from '@/main/app/schemas'
import { claimPreflight as preflight } from '@/main/pipeline/claim'

export const claimPreflight = defineAction({
  name: 'claim.preflight',
  kind: 'query',
  input: z.object({ repoId, number: positiveInt }),
  run: (ctx, input) => preflight(ctx, input),
})
