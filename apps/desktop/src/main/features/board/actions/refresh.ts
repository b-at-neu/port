import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { repoId } from '@/main/app/schemas'
import { resolveBoardRefresh } from '@/main/channels/board'
import { listRepositories } from '@/main/registry'
import { SOURCE_KINDS } from '@/types/board'

export const boardRefresh = defineAction({
  name: 'board.refresh',
  kind: 'mutation',
  input: z.object({ repoId: repoId.optional(), source: z.enum(SOURCE_KINDS).optional() }).optional(),
  run: (ctx, input) => resolveBoardRefresh(ctx.repos.deps, input, { listRepositories, refresh: ctx.live.watcher.refresh }),
})
