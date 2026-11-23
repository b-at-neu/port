import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { resolveTranscriptTailOpen } from '@/main/features/history/resolve'

export const transcriptTailOpen = defineAction({
  name: 'transcript.tailOpen',
  kind: 'mutation',
  input: z.object({ sessionId: z.string().min(1), agentId: z.string().nullable() }),
  run: (ctx, input) => resolveTranscriptTailOpen(input, ctx.live.offload.tail),
})
