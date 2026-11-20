import type { ApplyLabelsParams, PostCommentParams } from '@/types/writes'

// State-first, then (only once the state moved, and only when the plan carries one) the comment —
// a failed comment must still leave the state write standing.
import type { LabelWriteRequest, WriteOutcome } from '@/types/writes'
import { stateMoved } from '@/types/writes'

import { observationWrite } from '@/main/dispatch/observation'
import { commentRepeats } from '../../../../../scripts/port-tick/gates'

import type { ApplyObservationResult, ApplyObservationParams } from '@/types/actions'

interface ApplyObservationDeps {
  readonly writeState: (params: ApplyLabelsParams) => Promise<WriteOutcome>
  readonly postComment: (params: PostCommentParams) => Promise<WriteOutcome>
}

export async function applyObservation(params: ApplyObservationParams, deps: ApplyObservationDeps): Promise<ApplyObservationResult> {
  const plan = observationWrite(params.observation, params.item, params.entry.config.vocabulary, params.entry.config.branches.integration)
  const request: LabelWriteRequest = {
    repoId: params.entry.id,
    repo: params.entry.config.repo,
    kind: params.observation.itemKind,
    number: params.observation.number,
    vocabulary: params.entry.config.vocabulary,
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
