import type { PostCommentParams, WriteStateParams } from '@/types/writes'
import { mirrorVocabularyOf } from '@/utils/labels/display'

// Swaps the trigger label for `needsHuman`, then comments — a failed swap never posts a
// comment that would repeat on every poll.
import type { LabelWriteRequest, WriteOutcome } from '@/types/writes'
import { stateMoved } from '@/types/writes'

import type { EscalateToHumanResult, EscalateToHumanParams } from '@/types/actions'

export interface EscalateToHumanDeps {
  readonly writeState: (params: WriteStateParams) => Promise<WriteOutcome>
  readonly postComment: (params: PostCommentParams) => Promise<WriteOutcome>
}

function buildWriteRequest(params: EscalateToHumanParams): LabelWriteRequest {
  return {
    repoId: params.entry.id,
    repo: params.entry.config.repo,
    kind: params.kind,
    number: params.number,
    vocabulary: params.entry.config.vocabulary,
    mirror: mirrorVocabularyOf(params.entry.config),
    add: ['needsHuman'],
    remove: [params.trigger],
    addAssignees: [],
    removeAssignees: [],
    expect: { present: [params.trigger], absent: ['needsHuman'], assignees: { kind: 'exactly', logins: [params.viewer] } },
    action: params.action,
    ...(params.incident === undefined ? {} : { incident: params.incident }),
  }
}

export async function escalateToHuman(params: EscalateToHumanParams, deps: EscalateToHumanDeps): Promise<EscalateToHumanResult> {
  const labels = await deps.writeState({ request: buildWriteRequest(params), repoRoot: params.entry.path, auditDir: params.auditDir })
  if (!stateMoved(labels) || params.body === null) return { labels, comment: null }

  const comment = await deps.postComment({
    request: { repoId: params.entry.id, repo: params.entry.config.repo, kind: params.kind, number: params.number, body: params.body, action: params.action, scratchDir: params.scratchDir },
    repoRoot: params.entry.path,
    auditDir: params.auditDir,
  })
  return { labels, comment }
}
