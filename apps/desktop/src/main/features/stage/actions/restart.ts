import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { resolveStageRestart } from '@/main/channels/stage'

export const stageRestart = defineAction({ name: 'stage.restart', kind: 'mutation', input: z.object({ id: z.string().min(1) }), run: (ctx, input) => resolveStageRestart(ctx.repos.deps, input, ctx.seams.stage) })
