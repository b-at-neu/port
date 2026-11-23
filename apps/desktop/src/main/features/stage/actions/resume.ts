import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { resolveStageResume } from '@/main/channels/stage'

export const stageResume = defineAction({ name: 'stage.resume', kind: 'mutation', input: z.object({ id: z.string().min(1) }), run: (ctx, input) => resolveStageResume(ctx.repos.deps, input, ctx.seams.stage) })
