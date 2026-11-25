import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { positiveInt, repoId } from '@/main/app/schemas'
import { resolveClaimApply } from '@/main/features/claim/resolve'
import { PLAN_GATE_CHOICES } from '@/types/claim'

export const claimApply = defineAction({
  name: 'claim.apply',
  kind: 'mutation',
  input: z.object({ repoId, number: positiveInt, planGate: z.enum(PLAN_GATE_CHOICES), confirmedAssignees: z.array(z.string()).readonly() }),
  run: (ctx, input) => resolveClaimApply(ctx, input, ctx.paths.userData),
})
