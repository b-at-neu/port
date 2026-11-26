import { z } from 'zod'
import { defineAction } from '@/main/app/define'

export const transcriptTailOpen = defineAction({
  name: 'transcript.tailOpen',
  kind: 'mutation',
  input: z.object({ sessionId: z.string().min(1), agentId: z.string().nullable() }),
  run: (ctx, input) => ctx.live.engine.tailOpen(input),
})
