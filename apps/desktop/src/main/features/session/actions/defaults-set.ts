import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { resolveSessionDefaultsSet } from '@/main/channels/hosting'
import { SESSION_MODELS, SESSION_PERMISSION_MODES } from '@/types/hosting'

export const sessionDefaultsSet = defineAction({
  name: 'session.defaultsSet',
  kind: 'mutation',
  input: z.object({ model: z.enum(SESSION_MODELS).nullable(), permissionMode: z.enum(SESSION_PERMISSION_MODES) }),
  run: (ctx, input) => resolveSessionDefaultsSet(input, ctx.seams.hosting),
})
