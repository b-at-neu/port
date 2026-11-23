import { defineAction } from '@/main/app/define'
import { noInput } from '@/main/app/schemas'
import { forgetRepoState } from '@/main/features/repos/forget'

export const reposAdd = defineAction({
  name: 'repos.add',
  kind: 'mutation',
  input: noInput,
  run: async (ctx) => {
    const result = await ctx.repos.add()
    if (result.ok && result.outcome === 'added') forgetRepoState(ctx, 'repos.add', result.added)
    return result
  },
})
