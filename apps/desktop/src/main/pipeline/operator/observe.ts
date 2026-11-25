import type { PostCommentParams, WriteStateParams } from '@/types/writes'
import { mirrorVocabularyOf } from '@/utils/labels/display'

// State-first, then (only once the state moved, and only when the plan carries one) the comment —
// a failed comment must still leave the state write standing.
import type { LabelWriteRequest, WriteOutcome } from '@/types/writes'
import { stateMoved } from '@/types/writes'

import { observationWrite } from '@/main/pipeline/observation'
import { observationIntent } from '@/main/pipeline/incidents/raise'
import { commentRepeats } from '@/utils/pipeline/gates'

import { planPresentIn } from '@/main/pipeline/board/link'

import type { ApplyObservationResult, ApplyObservationParams } from '@/types/actions'
import type { GateDeps } from '@/types/gate'

interface ApplyObservationDeps {
  readonly writeState: (params: WriteStateParams) => Promise<WriteOutcome>
  readonly postComment: (params: PostCommentParams) => Promise<WriteOutcome>
  readonly fetchGatePreflight: GateDeps['fetchGatePreflight']
}

/** Re-reads the body over GitHub: the snapshot may predate the hand-back's body edit. `null` means the plan is still missing and the write may proceed; any other outcome stops it, unwritten. */
async function planStillMissing(params: ApplyObservationParams, deps: ApplyObservationDeps): Promise<WriteOutcome | null> {
  const { config } = params.entry
  const fetch = await deps.fetchGatePreflight({ repo: { owner: config.owner, name: config.name }, number: params.observation.number })
  if (!fetch.ok) return { kind: 'verify-failed', message: fetch.message }
  if (fetch.item === null || fetch.item.kind !== 'issue') return { kind: 'item-unavailable' }
  return planPresentIn(fetch.item.body) ? { kind: 'no-op' } : null
}

export async function applyObservation(params: ApplyObservationParams, deps: ApplyObservationDeps): Promise<ApplyObservationResult> {
  if (params.observation.kind === 'plan-missing') {
    const stopped = await planStillMissing(params, deps)
    if (stopped !== null) return { labels: stopped, comment: null }
  }

  const plan = observationWrite(params.observation, params.item, params.entry.config.vocabulary, params.entry.config.branches.integration)
  const incident = observationIntent(params.observation, params.item, plan, params.snapshotAt ?? null)
  const request: LabelWriteRequest = {
    ...(incident === null ? {} : { incident }),
    repoId: params.entry.id,
    repo: params.entry.config.repo,
    kind: params.observation.itemKind,
    number: params.observation.number,
    vocabulary: params.entry.config.vocabulary,
    mirror: mirrorVocabularyOf(params.entry.config),
    add: plan.add,
    remove: plan.remove,
    addAssignees: [],
    removeAssignees: [],
    expect: plan.expect,
    action: plan.action,
  }

  const labels = await deps.writeState({ request, repoRoot: params.entry.path, auditDir: params.auditDir })
  if (!stateMoved(labels) || plan.comment === null) return { labels, comment: null }
  if (commentRepeats({ body: plan.comment, comments: params.item.comments ?? undefined, headRefOid: params.item.headRefOid ?? '' })) return { labels, comment: null }

  const comment = await deps.postComment({
    request: {
      repoId: params.entry.id,
      repo: params.entry.config.repo,
      kind: params.observation.itemKind,
      number: params.observation.number,
      body: plan.comment,
      action: plan.action,
      scratchDir: params.scratchDir,
    },
    repoRoot: params.entry.path,
    auditDir: params.auditDir,
  })
  return { labels, comment }
}
