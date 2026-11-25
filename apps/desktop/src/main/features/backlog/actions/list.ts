import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { repoId } from '@/main/app/schemas'
import { defaultBacklogListDeps, resolveBacklogList } from '@/main/features/backlog/resolve'

export const backlogList = defineAction({
  name: 'backlog.list',
  kind: 'query',
  input: z.object({ repoId }),
  run: (ctx, input) => resolveBacklogList(ctx, ctx.repos.deps, input, { ...defaultBacklogListDeps, trackedRefs: ctx.stores.pipelineState.watcherDeps.trackedRefs }),
})
