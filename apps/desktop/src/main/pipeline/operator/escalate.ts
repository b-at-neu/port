import { mirrorVocabularyOf } from '@/utils/labels/display'

// Swaps the trigger label for `needsHuman`, then comments — a failed swap never posts a
// comment that would repeat on every poll.
import type { LabelWriteRequest } from '@/types/writes'
import { stateMoved } from '@/types/writes'
import { postComment } from '@/main/github/writes/apply'
import type { StateWriteContext } from '@/main/pipeline/context'
import { writeState } from '@/main/pipeline/state/writer'

import type { EscalateToHumanResult, EscalateToHumanParams } from '@/types/actions'

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

export async function escalateToHuman(ctx: StateWriteContext, params: EscalateToHumanParams): Promise<EscalateToHumanResult> {
  const labels = await writeState(ctx, { request: buildWriteRequest(params), repoRoot: params.entry.path, auditDir: params.auditDir })
  if (!stateMoved(labels) || params.body === null) return { labels, comment: null }

  const comment = await postComment(ctx, {
    request: { repoId: params.entry.id, repo: params.entry.config.repo, kind: params.kind, number: params.number, body: params.body, action: params.action, scratchDir: params.scratchDir },
    repoRoot: params.entry.path,
    auditDir: params.auditDir,
  })
  return { labels, comment }
}
