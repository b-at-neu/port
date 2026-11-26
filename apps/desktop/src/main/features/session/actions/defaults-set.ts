import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { SESSION_MODELS, SESSION_PERMISSION_MODES } from '@/types/hosting'

export const sessionDefaultsSet = defineAction({
  name: 'session.defaultsSet',
  kind: 'mutation',
  input: z.object({ model: z.enum(SESSION_MODELS).nullable(), permissionMode: z.enum(SESSION_PERMISSION_MODES) }),
  run: (ctx, input) => ctx.live.hostedStore.setDefaults(input),
})
