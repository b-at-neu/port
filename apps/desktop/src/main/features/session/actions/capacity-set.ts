import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { resolveSessionCapacitySet } from '@/main/features/session/resolve'
import { SESSION_LIMIT_CEILING } from '@/main/hosting/persist'

export const sessionCapacitySet = defineAction({
  name: 'session.capacitySet',
  kind: 'mutation',
  input: z.object({ limit: z.int().min(1).max(SESSION_LIMIT_CEILING) }),
  run: (ctx, input) => resolveSessionCapacitySet(input, ctx.seams.hosting),
})
