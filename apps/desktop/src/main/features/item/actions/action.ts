import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { expectedView, positiveInt, repoId } from '@/main/app/schemas'
import { refreshAfterWrite } from '@/main/features/board'
import { readyEntryOf } from '@/main/pipeline/context'
import { applyItemAction } from '@/main/pipeline/operator/apply'
import { OPERATOR_ACTIONS } from '@/types/actions'

const SUBJECT = "'item:action'"

export const itemAction = defineAction({
  name: 'item.action',
  kind: 'mutation',
  input: z.object({ repoId, kind: z.enum(['issue', 'pull-request']), number: positiveInt, action: z.enum(OPERATOR_ACTIONS), expected: expectedView }),
  run: async (ctx, input) => {
    const entry = await readyEntryOf(ctx, SUBJECT, input.repoId, (message) => `${SUBJECT} could not list repositories: ${message}`)
    const result = await applyItemAction(ctx, { request: input, snapshot: ctx.live.watcher.snapshot(), entry, auditDir: ctx.paths.userData })
    if (result.ok && result.outcome.kind === 'applied') await refreshAfterWrite(ctx, SUBJECT, input.repoId)
    return result
  },
})
