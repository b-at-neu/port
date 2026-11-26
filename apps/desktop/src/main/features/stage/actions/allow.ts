import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { repoId } from '@/main/app/schemas'
import { allowDenial } from '@/main/features/stage/allow'

export const stageAllow = defineAction({
  name: 'stage.allow',
  kind: 'mutation',
  input: z.object({ repoId, denialId: z.string().min(1), rule: z.string().min(1).max(300) }),
  run: (ctx, input) => allowDenial(ctx, input),
})
