import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { positiveInt, repoId } from '@/main/app/schemas'
import { resolveClaimPreflight } from '@/main/features/claim/resolve'

export const claimPreflight = defineAction({
  name: 'claim.preflight',
  kind: 'query',
  input: z.object({ repoId, number: positiveInt }),
  run: (ctx, input) => resolveClaimPreflight(ctx.repos.deps, input, ctx.live.actions.claimDeps),
})
