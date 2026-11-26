import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { positiveInt, repoId } from '@/main/app/schemas'
import { resolveForceDispatch } from '@/main/features/held/resolve'

export const heldForceDispatch = defineAction({
  name: 'held.forceDispatch',
  kind: 'mutation',
  input: z.object({ repoId, number: positiveInt }),
  run: (ctx, input) => resolveForceDispatch(ctx, input),
})
