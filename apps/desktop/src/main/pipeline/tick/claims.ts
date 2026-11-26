// Pure: one claim per ticket the record says is running, classified against live sessions and the run ledger.
import type { PipelineItemKind } from '@/types/github'
import type { ReconciledItem } from '@/types/state'
import type { TickClaim } from '@/types/tick'
import type { RepoId } from '@/utils/repos'
import type { Run } from '@/utils/pipeline/ticket'
import { STAGE_TABLE } from '@/utils/pipeline/stages'
import { unmatchedClaimOf } from '@/main/pipeline/runs'
import { actsOn } from '@/main/pipeline/tick/holds'

interface ClaimsOfParams {
  readonly items: readonly ReconciledItem[]
  readonly repoId: RepoId
  readonly runsOf: (repoId: RepoId, kind: PipelineItemKind, number: number) => readonly Run[]
  readonly startedTasks: readonly string[]
  readonly readAt: string | null
  readonly holdSessionRequired: boolean
  readonly stageLiveness: { readonly live: readonly string[]; readonly interrupted: readonly string[] } | null
}

export function claimsOf({ items, repoId, runsOf, startedTasks, readAt, holdSessionRequired, stageLiveness }: ClaimsOfParams): readonly TickClaim[] {
  const claims: TickClaim[] = []
  for (const item of items) {
    if (!actsOn(item) || item.ticket.status.kind !== 'running') continue
    const { stage } = item.ticket
    const base = { number: item.number, kind: item.kind, stage }

    if (holdSessionRequired && item.sessionRequired) {
      claims.push({ ...base, class: 'session-required', retryable: false })
      continue
    }

    const agent = STAGE_TABLE[stage].running.agent
    const description = agent !== null ? `${agent} #${String(item.number)}` : null

    if (stageLiveness !== null) {
      if (description !== null && stageLiveness.live.includes(description)) {
        claims.push({ ...base, class: 'matched', retryable: false })
        continue
      }
      if (description !== null && stageLiveness.interrupted.includes(description)) {
        claims.push({ ...base, class: 'interrupted', retryable: false })
        continue
      }
      // A transcript `in-flight` status alone is no longer matched once this app owns liveness.
    } else {
      // Either source is enough to hold a reset back, so a reset never fires against an agent this process itself just dispatched before the session scan has caught up to it.
      const matchedByTask = description !== null && startedTasks.includes(description)
      if (item.status === 'in-flight' || matchedByTask) {
        claims.push({ ...base, class: 'matched', retryable: false })
        continue
      }
    }

    const result = agent === null ? 'no-record' : unmatchedClaimOf(runsOf(repoId, item.kind, item.number), stage, readAt)
    const cls = result === 'reset' ? 'stalled-confirmed' : result
    claims.push({ ...base, class: cls, retryable: cls === 'stalled-confirmed' })
  }
  return claims
}
