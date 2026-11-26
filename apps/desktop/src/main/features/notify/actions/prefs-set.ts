import { z } from 'zod'
import { defineAction } from '@/main/app/define'

export const notifyPrefsSet = defineAction({
  name: 'notify.prefsSet',
  kind: 'mutation',
  input: z.object({ needsYou: z.boolean(), sessions: z.boolean() }),
  run: (ctx, input) => ctx.live.hostedStore.setNotificationPrefs(input),
})
