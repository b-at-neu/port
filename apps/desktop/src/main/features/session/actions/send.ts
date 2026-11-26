import { defineAction } from '@/main/app/define'
import { sendInput } from '@/main/features/session/schemas'

export const sessionSend = defineAction({
  name: 'session.send',
  kind: 'mutation',
  input: sendInput,
  run: (ctx, input) => ctx.live.hostedStore.send(input.sessionKey, input.text, input.attachments ?? [], { source: 'operator' }),
})
