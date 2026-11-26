import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { restartStage } from '@/main/dispatch/stage/recover'

export const stageRestart = defineAction({ name: 'stage.restart', kind: 'mutation', input: z.object({ id: z.string().min(1) }), run: (ctx, input) => restartStage(ctx, input.id) })
