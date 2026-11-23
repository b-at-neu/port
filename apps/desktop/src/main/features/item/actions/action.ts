import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { expectedStage, positiveInt, repoId } from '@/main/app/schemas'
import { resolveItemAction } from '@/main/features/item/resolve'
import { listRepositories } from '@/main/registry'
import { OPERATOR_ACTIONS } from '@/types/actions'

export const itemAction = defineAction({
  name: 'item.action',
  kind: 'mutation',
  input: z.object({ repoId, kind: z.enum(['issue', 'pull-request']), number: positiveInt, action: z.enum(OPERATOR_ACTIONS), expectedStage }),
  run: (ctx, input) =>
    resolveItemAction(ctx.repos.deps, input, ctx.paths.userData, {
      listRepositories,
      applyItemAction: ctx.live.actions.applyItemAction,
      snapshot: ctx.live.watcher.snapshot,
      refresh: ctx.live.watcher.refresh,
    }),
})
