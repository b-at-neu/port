import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { repoId } from '@/main/app/schemas'
import { scanSessions } from '@/main/features/history'

const scope = z.discriminatedUnion('kind', [z.object({ kind: z.literal('all') }), z.object({ kind: z.literal('repo'), repoId })])

export const searchQuery = defineAction({
  name: 'search.query',
  kind: 'query',
  input: z.object({ query: z.string().min(1), scope }),
  run: async (ctx, input) => {
    const scan = await scanSessions(ctx)
    return ctx.live.engine.search({ scan, indexDir: ctx.paths.userData, query: input.query, scope: input.scope })
  },
})
