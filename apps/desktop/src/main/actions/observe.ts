import type { ApplyLabelsParams, PostCommentParams } from '@/types/writes'

// Label-first, then (only on `applied`, and only when the plan carries one) the comment —
// a failed comment must still leave the label write standing.
import type { LabelWriteRequest, WriteOutcome } from '@/types/writes'
import { applyLabels, postComment } from '@/main/writes/apply'

import { observationWrite } from '@/main/dispatch/observation'

import type { ApplyObservationResult, ApplyObservationParams } from '@/types/actions'

interface ApplyObservationDeps {
  readonly applyLabels: (params: ApplyLabelsParams) => Promise<WriteOutcome>
  readonly postComment: (params: PostCommentParams) => Promise<WriteOutcome>
}

export const defaultApplyObservationDeps: ApplyObservationDeps = { applyLabels, postComment }

export async function applyObservation(params: ApplyObservationParams, deps: ApplyObservationDeps = defaultApplyObservationDeps): Promise<ApplyObservationResult> {
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

  const labels = await deps.applyLabels({ request, repoRoot: params.entry.path, auditDir: params.auditDir })
  if (labels.kind !== 'applied' || plan.comment === null) return { labels, comment: null }

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
