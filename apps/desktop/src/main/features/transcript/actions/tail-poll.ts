import { z } from 'zod'
import { defineAction } from '@/main/app/define'

export const transcriptTailPoll = defineAction({
  name: 'transcript.tailPoll',
  kind: 'mutation',
  input: z.object({ tailId: z.string().min(1) }),
  run: (ctx, input) => ctx.live.engine.tailPoll(input),
})
