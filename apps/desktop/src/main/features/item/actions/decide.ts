import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { expectedStage, positiveInt, repoId } from '@/main/app/schemas'
import { resolveItemDecision } from '@/main/channels/items'
import { listRepositories } from '@/main/registry'
import { MAX_REVISE_NOTE_CHARS, OPERATOR_DECISIONS, UNBLOCK_ROUTES } from '@/types/actions'

const picks = z.array(z.object({ id: z.string().regex(/^D\d+$/), letter: z.string().regex(/^[A-Z]$/) })).max(20).readonly()

export const itemDecide = defineAction({
  name: 'item.decide',
  kind: 'mutation',
  input: z.object({
    repoId,
    number: positiveInt,
    decision: z.enum(OPERATOR_DECISIONS),
    expectedStage,
    route: z.enum(UNBLOCK_ROUTES).nullable(),
    note: z.string().max(MAX_REVISE_NOTE_CHARS).nullable(),
    skipComment: z.boolean(),
    picks: picks.nullable(),
  }),
  run: (ctx, input) =>
    resolveItemDecision(ctx.repos.deps, input, ctx.paths.userData, ctx.paths.temp, {
      listRepositories,
      applyItemDecision: ctx.live.actions.applyItemDecision,
      sessions: () => ctx.live.hostedStore.list(),
      snapshot: ctx.live.watcher.snapshot,
      refresh: ctx.live.watcher.refresh,
    }),
})
