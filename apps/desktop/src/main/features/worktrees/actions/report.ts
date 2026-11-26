import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { repoId } from '@/main/app/schemas'
import { readWorktreesReport } from '@/main/features/worktrees/resolve'

export const worktreesReport = defineAction({ name: 'worktrees.report', kind: 'query', input: z.object({ id: repoId }), run: (ctx, input) => readWorktreesReport(ctx, input) })
