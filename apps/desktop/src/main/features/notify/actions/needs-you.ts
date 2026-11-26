import { z } from 'zod'
import { defineAction } from '@/main/app/define'

const MAX_NOTIFICATION_TEXT = 200

const text = z.string().min(1).max(MAX_NOTIFICATION_TEXT)

export const notifyNeedsYou = defineAction({
  name: 'notify.needsYou',
  kind: 'mutation',
  input: z.object({ title: text, body: text, focus: z.string().nullable() }),
  run: (ctx, input) => ctx.live.notifier.showNeedsYou(input),
})
