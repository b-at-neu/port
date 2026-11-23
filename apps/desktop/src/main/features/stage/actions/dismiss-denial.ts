import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { repoId } from '@/main/app/schemas'
import { resolveStageDismissDenial } from '@/main/channels/stage'

export const stageDismissDenial = defineAction({
  name: 'stage.dismissDenial',
  kind: 'mutation',
  input: z.object({ repoId, denialId: z.string().min(1) }),
  run: (ctx, input) => resolveStageDismissDenial(input, ctx.seams.stage),
})
