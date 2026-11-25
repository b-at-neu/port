import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { expectedStage, positiveInt, repoId } from '@/main/app/schemas'
import { refreshAfterWrite } from '@/main/features/board'
import { readyEntryOf } from '@/main/pipeline/context'
import { applyItemDecision } from '@/main/pipeline/operator/decide'
import { MAX_REVISE_NOTE_CHARS, OPERATOR_DECISIONS, UNBLOCK_ROUTES } from '@/types/actions'
import { isLiveStageSession } from '@/utils/stage/live'

const SUBJECT = "'item:decide'"

const picks = z.array(z.object({ id: z.string().regex(/^D\d+$/), letter: z.string().regex(/^[A-Z]$/) })).max(20).readonly()

const input = z
  .object({
    repoId,
    number: positiveInt,
    decision: z.enum(OPERATOR_DECISIONS),
    expectedStage,
    route: z.enum(UNBLOCK_ROUTES).nullable(),
    note: z.string().max(MAX_REVISE_NOTE_CHARS).nullable(),
    skipComment: z.boolean(),
    picks: picks.nullable(),
  })
  .superRefine((value, ctx) => {
    const reject = (path: 'route' | 'note' | 'picks' | 'skipComment', message: string) => ctx.addIssue({ code: 'custom', path: [path], message })
    if (value.decision === 'unblock') {
      if (value.route === null) reject('route', "'route' is required for 'unblock'")
      if (value.note !== null) reject('note', "'note' must be null for 'unblock'")
    } else if (value.decision === 'grant') {
      if (value.route !== null) reject('route', "'route' must be null for 'grant'")
      if (value.note !== null) reject('note', "'note' must be null for 'grant'")
      if (value.picks !== null) reject('picks', "'picks' must be null for 'grant'")
      if (value.skipComment) reject('skipComment', "'skipComment' must be false for 'grant'")
    } else {
      if (value.route !== null) reject('route', "'route' must be null for 'revise'")
      if (value.picks !== null) reject('picks', "'picks' must be null for 'revise'")
      if (value.note === null) reject('note', "'note' is required for 'revise'")
    }
  })

export const itemDecide = defineAction({
  name: 'item.decide',
  kind: 'mutation',
  input,
  run: async (ctx, request) => {
    const entry = await readyEntryOf(ctx, SUBJECT, request.repoId, (message) => `${SUBJECT} could not list repositories: ${message}`)
    const liveStage = ctx.live.hostedStore.list().some((s) => s.repoId === request.repoId && s.stage?.number === request.number && isLiveStageSession(s))
    const result = await applyItemDecision(ctx, {
      request,
      snapshot: ctx.live.watcher.snapshot(),
      entry,
      auditDir: ctx.paths.userData,
      scratchDir: ctx.paths.temp,
      liveStage,
    })
    if (result.ok && result.labels.kind === 'applied') await refreshAfterWrite(ctx, SUBJECT, request.repoId)
    return result
  },
})
