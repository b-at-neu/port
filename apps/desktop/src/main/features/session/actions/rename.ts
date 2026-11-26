import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { sessionKey } from '@/main/app/schemas'
import { renameTitle } from '@/main/features/session/schemas'

export const sessionRename = defineAction({
  name: 'session.rename',
  kind: 'mutation',
  input: z.object({ sessionKey, title: renameTitle }),
  run: (ctx, input) => ctx.live.hostedStore.rename(input.sessionKey, input.title),
})
