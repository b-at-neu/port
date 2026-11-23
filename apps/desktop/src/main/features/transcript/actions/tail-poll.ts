import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { resolveTranscriptTailPoll } from '@/main/features/history/resolve'

export const transcriptTailPoll = defineAction({
  name: 'transcript.tailPoll',
  kind: 'mutation',
  input: z.object({ tailId: z.string().min(1) }),
  run: (ctx, input) => resolveTranscriptTailPoll(input, ctx.live.offload.tail),
})
