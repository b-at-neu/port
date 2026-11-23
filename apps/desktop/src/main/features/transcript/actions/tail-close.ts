import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { resolveTranscriptTailClose } from '@/main/features/history/resolve'

export const transcriptTailClose = defineAction({
  name: 'transcript.tailClose',
  kind: 'mutation',
  input: z.object({ tailId: z.string().min(1) }),
  run: (ctx, input) => resolveTranscriptTailClose(input, ctx.live.offload.tail),
})
