import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'
import { resolveNotifyPrefs } from '@/main/channels/notify'

export const notifyPrefs = defineAction({
  name: 'notify.prefs',
  kind: 'query',
  input: noInput,
  run: (ctx, input) => resolveNotifyPrefs(input, { prefs: () => ctx.live.hostedStore.notificationPrefs(), setPrefs: (next) => ctx.live.hostedStore.setNotificationPrefs(next) }),
})
