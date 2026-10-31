import type { ApplyLabelsParams, PostCommentParams } from '@/types/writes'

// Swaps the trigger label for `needsHuman`, then comments — a failed swap never posts a
// comment that would repeat on every poll.
import type { LabelWriteRequest, WriteOutcome } from '@/types/writes'
import { applyLabels, postComment } from '@/main/writes/apply'


import type { EscalateToHumanResult, EscalateToHumanParams } from '@/types/actions'

export interface EscalateToHumanDeps {
  readonly applyLabels: (params: ApplyLabelsParams) => Promise<WriteOutcome>
  readonly postComment: (params: PostCommentParams) => Promise<WriteOutcome>
}

export const defaultEscalateDeps: EscalateToHumanDeps = { applyLabels, postComment }

function buildWriteRequest(params: EscalateToHumanParams): LabelWriteRequest {
  return {
    repoId: params.entry.id,
    repo: params.entry.config.repo,
    kind: params.kind,
    number: params.number,
    vocabulary: params.entry.config.vocabulary,
    add: ['needsHuman'],
    remove: [params.trigger],
    addAssignees: [],
    removeAssignees: [],
    expect: { present: [params.trigger], absent: ['needsHuman'], assignees: { kind: 'exactly', logins: [params.viewer] } },
    action: params.action,
  }
}

export async function escalateToHuman(params: EscalateToHumanParams, deps: EscalateToHumanDeps = defaultEscalateDeps): Promise<EscalateToHumanResult> {
  const labels = await deps.applyLabels({ request: buildWriteRequest(params), repoRoot: params.entry.path, auditDir: params.auditDir })
  if (labels.kind !== 'applied') return { labels, comment: null }

  const comment = await deps.postComment({
    request: { repoId: params.entry.id, repo: params.entry.config.repo, kind: params.kind, number: params.number, body: params.body, action: params.action, scratchDir: params.scratchDir },
    repoRoot: params.entry.path,
    auditDir: params.auditDir,
  })
  return { labels, comment }
}
