import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { repoId } from '@/main/app/schemas'
import { releaseIssuesOf } from '@/main/features/release/resolve'

const tag = z.string().regex(/^[A-Za-z0-9._+/-]{1,255}$/)

export const releaseIssues = defineAction({
  name: 'release.issues',
  kind: 'query',
  input: z.object({ repoId, tag, previousTag: tag.nullable() }),
  run: (ctx, input) => releaseIssuesOf(ctx, input),
})
