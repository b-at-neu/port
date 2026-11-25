import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { repoId } from '@/main/app/schemas'
import { resolveReleaseStatus } from '@/main/features/release/resolve'

export const releaseStatus = defineAction({ name: 'release.status', kind: 'query', input: z.object({ repoId }), run: (ctx, input) => resolveReleaseStatus(ctx, ctx.repos.deps, input) })
