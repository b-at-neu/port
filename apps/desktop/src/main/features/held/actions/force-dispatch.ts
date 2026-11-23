import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { positiveInt, repoId } from '@/main/app/schemas'
import { resolveForceDispatch } from '@/main/channels/held'

export const heldForceDispatch = defineAction({
  name: 'held.forceDispatch',
  kind: 'mutation',
  input: z.object({ repoId, number: positiveInt }),
  run: (ctx, input) =>
    resolveForceDispatch(input, {
      snapshot: ctx.live.watcher.snapshot,
      dispatcherStatus: () => ctx.live.dispatcher.status(),
      forceDispatch: ctx.live.forceDispatch,
      republish: () => ctx.live.watcher.republish(),
    }),
})
