import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { MAX_NOTIFICATION_TEXT, resolveNotifyNeedsYou } from '@/main/features/notify/resolve'

const text = z.string().min(1).max(MAX_NOTIFICATION_TEXT)

export const notifyNeedsYou = defineAction({
  name: 'notify.needsYou',
  kind: 'mutation',
  input: z.object({ title: text, body: text, focus: z.string().nullable() }),
  run: (ctx, input) => resolveNotifyNeedsYou(input, { show: (notification) => ctx.live.notifier.showNeedsYou(notification) }),
})
