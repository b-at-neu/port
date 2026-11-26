import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { repoId } from '@/main/app/schemas'

export const stageDismissDenial = defineAction({
  name: 'stage.dismissDenial',
  kind: 'mutation',
  input: z.object({ repoId, denialId: z.string().min(1) }),
  run: (ctx, input) => ctx.live.dispatcher.dismissDenial(input.repoId, input.denialId),
})
