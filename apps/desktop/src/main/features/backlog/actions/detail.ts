import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { positiveInt, repoId } from '@/main/app/schemas'
import { resolveBacklogDetail } from '@/main/channels/backlog'

export const backlogDetail = defineAction({
  name: 'backlog.detail',
  kind: 'query',
  input: z.object({ repoId, number: positiveInt }),
  run: (ctx, input) => resolveBacklogDetail(ctx.repos.deps, input),
})
