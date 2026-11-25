import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { repoId } from '@/main/app/schemas'
import { resolveBoardRefresh } from '@/main/features/board/resolve'
import { listRepositories } from '@/main/repos'
import { SOURCE_KINDS } from '@/types/board'

export const boardRefresh = defineAction({
  name: 'board.refresh',
  kind: 'mutation',
  input: z.object({ repoId: repoId.optional(), source: z.enum(SOURCE_KINDS).optional() }).optional(),
  run: (ctx, input) => resolveBoardRefresh(ctx.repos.deps, input, { listRepositories, refresh: ctx.live.watcher.refresh }),
})
