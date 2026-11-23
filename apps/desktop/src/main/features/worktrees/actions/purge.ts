import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { repoId } from '@/main/app/schemas'
import { resolveWorktreesPurge } from '@/main/channels/worktrees'

export const worktreesPurge = defineAction({
  name: 'worktrees.purge',
  kind: 'mutation',
  input: z.object({ id: repoId, path: z.string().min(1) }),
  run: (ctx, input) => resolveWorktreesPurge(ctx.repos.deps, input, ctx.paths.userData),
})
