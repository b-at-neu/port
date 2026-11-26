import { z } from 'zod'
import { defineAction } from '@/main/app/define'

export const transcriptTailClose = defineAction({
  name: 'transcript.tailClose',
  kind: 'mutation',
  input: z.object({ tailId: z.string().min(1) }),
  run: (ctx, input) => {
    void ctx.live.engine.tailClose(input)
  },
})
