import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { positiveInt, repoId } from '@/main/app/schemas'
import { resolveAuditList } from '@/main/channels/audit'

export const auditList = defineAction({
  name: 'audit.list',
  kind: 'query',
  input: z.object({ repoId: repoId.nullable(), number: positiveInt.nullable() }),
  run: (ctx, input) => resolveAuditList(ctx.repos.deps, input, ctx.paths.userData),
})
