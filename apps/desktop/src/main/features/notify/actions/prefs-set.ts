import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { resolveNotifyPrefsSet } from '@/main/features/notify/resolve'

export const notifyPrefsSet = defineAction({
  name: 'notify.prefsSet',
  kind: 'mutation',
  input: z.object({ needsYou: z.boolean(), sessions: z.boolean() }),
  run: (ctx, input) => resolveNotifyPrefsSet(input, { prefs: () => ctx.live.hostedStore.notificationPrefs(), setPrefs: (next) => ctx.live.hostedStore.setNotificationPrefs(next) }),
})
