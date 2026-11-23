import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { repoId } from '@/main/app/schemas'
import { resolveStageAllow } from '@/main/channels/stage'

export const stageAllow = defineAction({
  name: 'stage.allow',
  kind: 'mutation',
  input: z.object({ repoId, denialId: z.string().min(1), rule: z.string().min(1).max(300) }),
  run: (ctx, input) => resolveStageAllow(ctx.repos.deps, input, ctx.seams.stage),
})
