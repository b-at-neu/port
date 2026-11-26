import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { SESSION_LIMIT_CEILING } from '@/main/sessions/hosting/persist'

export const sessionCapacitySet = defineAction({
  name: 'session.capacitySet',
  kind: 'mutation',
  input: z.object({ limit: z.int().min(1).max(SESSION_LIMIT_CEILING) }),
  run: (ctx, input) => ctx.live.hostedStore.setLimit(input.limit),
})
