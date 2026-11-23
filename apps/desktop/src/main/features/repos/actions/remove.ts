import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { repoId } from '@/main/app/schemas'
import { forgetRepoState } from '@/main/features/repos/forget'
import { removeRepository } from '@/main/registry'

export const reposRemove = defineAction({
  name: 'repos.remove',
  kind: 'mutation',
  input: z.object({ id: repoId }),
  run: async (ctx, input) => {
    const result = await removeRepository(ctx.repos.deps, input.id)
    if (result.ok) forgetRepoState(ctx, 'repos.remove', input.id)
    return result
  },
})
