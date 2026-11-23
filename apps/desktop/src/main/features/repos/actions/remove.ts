import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { repoId } from '@/main/app/schemas'
import { forgetRepoState } from '@/main/features/repos/forget'

export const reposRemove = defineAction({
  name: 'repos.remove',
  kind: 'mutation',
  input: z.object({ id: repoId }),
  run: async (ctx, input) => {
    const result = await ctx.repos.remove(input.id)
    if (result.ok) forgetRepoState(ctx, 'repos.remove', input.id)
    return result
  },
})
