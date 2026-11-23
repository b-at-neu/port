import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { positiveInt, repoId } from '@/main/app/schemas'
import { resolveWorktreesReclaim } from '@/main/channels/worktrees'

const force = z.strictObject({ path: z.string().min(1), unlock: z.boolean(), forceDirty: z.boolean() }).refine((value) => value.unlock || value.forceDirty, { message: 'must set at least one flag' })

export const worktreesReclaim = defineAction({
  name: 'worktrees.reclaim',
  kind: 'mutation',
  input: z.object({ id: repoId, issue: positiveInt.nullable(), force: force.nullable() }).refine((value) => value.force === null || value.issue === null, { message: "'issue' must be null when 'force' is set" }),
  run: (ctx, input) => resolveWorktreesReclaim(ctx.repos.deps, input, ctx.paths.userData),
})
