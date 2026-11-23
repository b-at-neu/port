import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { repoId } from '@/main/app/schemas'
import { resolveSearchQuery } from '@/main/channels/sessions'

const scope = z.discriminatedUnion('kind', [z.object({ kind: z.literal('all') }), z.object({ kind: z.literal('repo'), repoId })])

export const searchQuery = defineAction({
  name: 'search.query',
  kind: 'query',
  input: z.object({ query: z.string().min(1), scope }),
  run: (ctx, input) => resolveSearchQuery(ctx.repos.deps, input, ctx.paths.userData, ctx.live.offload.search),
})
