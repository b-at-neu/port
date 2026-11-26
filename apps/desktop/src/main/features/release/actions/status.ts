import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { repoId } from '@/main/app/schemas'
import { releaseStatusOf } from '@/main/features/release/resolve'

export const releaseStatus = defineAction({ name: 'release.status', kind: 'query', input: z.object({ repoId }), run: (ctx, input) => releaseStatusOf(ctx, input) })
