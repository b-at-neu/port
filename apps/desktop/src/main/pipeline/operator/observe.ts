// State-first, then (only once the state moved, and only when the plan carries one) the comment —
// a failed comment must still leave the state write standing.
import type { WriteOutcome } from '@/types/writes'
import { stateMoved } from '@/types/writes'
import { postComment } from '@/main/github/writes/apply'
import type { StateWriteContext } from '@/main/pipeline/context'
import { writeMove } from '@/main/pipeline/operator/apply'

import { observationWrite } from '@/main/pipeline/observation'
import { observationIntent } from '@/main/pipeline/incidents/raise'
import { planPresentIn } from '@/main/pipeline/board/link'
import { commentRepeats } from '@/utils/pipeline/gates'

import type { ApplyObservationResult, ApplyObservationParams } from '@/types/actions'

/** Re-reads the body over GitHub: the snapshot may predate the hand-back's body edit. `null` means the plan is still missing and the write may proceed; any other outcome stops it, unwritten. */
async function planStillMissing(ctx: StateWriteContext, params: ApplyObservationParams): Promise<WriteOutcome | null> {
  const { config } = params.entry
  const fetch = await ctx.tracker.readGatePreflight({ repo: { owner: config.owner, name: config.name }, number: params.observation.number })
  if (!fetch.ok) return { kind: 'verify-failed', message: fetch.message }
  if (fetch.item === null || fetch.item.kind !== 'issue') return { kind: 'item-unavailable' }
  return planPresentIn(fetch.item.body) ? { kind: 'no-op' } : null
}

export async function applyObservation(ctx: StateWriteContext, params: ApplyObservationParams): Promise<ApplyObservationResult> {
  if (params.observation.kind === 'plan-missing') {
    const stopped = await planStillMissing(ctx, params)
    if (stopped !== null) return { labels: stopped, comment: null }
  }

  const { entry, item, observation } = params
  const ticket = ctx.stores.pipelineState.ticket(entry.id, { kind: observation.itemKind, number: observation.number })
  if (ticket === null) return { labels: { kind: 'item-unavailable' }, comment: null }

  const plan = observationWrite(observation, item, entry.config.branches.integration)
  const incident = observationIntent(observation, item, plan, params.snapshotAt ?? null)
  const labels = await writeMove(ctx, {
    ...(incident === null ? {} : { incident }),
    entry,
    kind: observation.itemKind,
    number: observation.number,
    ticket,
    move: plan.move,
    actor: null,
    assignees: { kind: 'exactly', logins: item.assignees },
    addAssignees: [],
    action: plan.action,
    auditDir: params.auditDir,
  })
  if (!stateMoved(labels) || plan.comment === null) return { labels, comment: null }
  if (commentRepeats({ body: plan.comment, comments: item.comments ?? undefined, headRefOid: item.headRefOid ?? '' })) return { labels, comment: null }

  const comment = await postComment(ctx, {
    request: {
      repoId: entry.id,
      repo: entry.config.repo,
      kind: observation.itemKind,
      number: observation.number,
      body: plan.comment,
      action: plan.action,
      scratchDir: params.scratchDir,
    },
    repoRoot: entry.path,
    auditDir: params.auditDir,
  })
  return { labels, comment }
}
