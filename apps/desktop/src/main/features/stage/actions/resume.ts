import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { resumeStage } from '@/main/dispatch/stage/recover'

export const stageResume = defineAction({ name: 'stage.resume', kind: 'mutation', input: z.object({ id: z.string().min(1) }), run: (ctx, input) => resumeStage(ctx, input.id) })
