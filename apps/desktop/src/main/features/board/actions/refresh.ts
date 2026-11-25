import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { repoId } from '@/main/app/schemas'
import { SOURCE_KINDS } from '@/types/board'

export const boardRefresh = defineAction({
  name: 'board.refresh',
  kind: 'mutation',
  input: z.object({ repoId: repoId.optional(), source: z.enum(SOURCE_KINDS).optional() }).optional(),
  run: async (ctx, input) => {
    if (input?.repoId !== undefined) {
      const list = await ctx.repos.list()
      if (!list.ok) throw new Error(`'board:refresh' could not list repositories: ${list.message}`)
      if (!list.repositories.some((repository) => repository.id === input.repoId)) {
        throw new Error(`'board:refresh' found no repository registered with id '${input.repoId}'`)
      }
    }
    return ctx.live.watcher.refresh(input)
  },
})
