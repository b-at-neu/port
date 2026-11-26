import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { startSession } from '@/main/features/session/resolve'
import { startMode, startTarget } from '@/main/features/session/schemas'

export const sessionStart = defineAction({
  name: 'session.start',
  kind: 'mutation',
  input: z.object({ target: startTarget, mode: startMode }).refine((value) => value.target.kind !== 'transcript' || value.mode.kind !== 'fresh', { message: "a transcript target never starts a 'fresh' session" }),
  run: (ctx, input) => startSession(ctx, input),
})
