// Moves the ticket to its escalation gate, then comments — a failed move never posts a
// comment that would repeat on every poll.
import { stateMoved } from '@/types/writes'
import { postComment } from '@/main/github/writes/apply'
import type { StateWriteContext } from '@/main/pipeline/context'
import { liveTicketOf, writeMove } from '@/main/pipeline/operator/apply'

import type { EscalateToHumanResult, EscalateToHumanParams } from '@/types/actions'

export async function escalateToHuman(ctx: StateWriteContext, params: EscalateToHumanParams): Promise<EscalateToHumanResult> {
  const ticket = liveTicketOf(ctx, params.entry.id, params.kind, params.number)
  if (ticket === null) return { labels: { kind: 'item-unavailable' }, comment: null }

  const labels = await writeMove(ctx, {
    ...(params.incident === undefined ? {} : { incident: params.incident }),
    entry: params.entry,
    kind: params.kind,
    number: params.number,
    ticket,
    move: { kind: 'escalate', detail: params.action },
    actor: params.viewer,
    assignees: { kind: 'exactly', logins: [params.viewer] },
    addAssignees: [],
    action: params.action,
    auditDir: params.auditDir,
  })
  if (!stateMoved(labels) || params.body === null) return { labels, comment: null }

  const comment = await postComment(ctx, {
    request: { repoId: params.entry.id, repo: params.entry.config.repo, kind: params.kind, number: params.number, body: params.body, action: params.action, scratchDir: params.scratchDir },
    repoRoot: params.entry.path,
    auditDir: params.auditDir,
  })
  return { labels, comment }
}
