// Pure: one machine-observation write's operator move, audit action, and comment body.
import type { OperatorMove } from '@/types/actions'
import type { ReconciledItem } from '@/types/state'
import type { TickObservation } from '@/types/tick'
import type { WriteObservation } from '@/types/dispatch'
import { CYCLE_CAP_ESCALATION_MARKER } from '@/utils/actions/bodies'

export interface ObservationWritePlan {
  readonly move: OperatorMove
  readonly action: string
  readonly comment: string | null
}

const PIPELINE_ESCALATION = '## Pipeline Escalation'

function escalationMarker(cause: 'sha-cap' | 'cycle-cap' | 'integration-red' | 'refresh-stuck', sha: string | null): string {
  return `\n<!-- port:escalation ${cause} ${sha ?? ''} -->`
}

function rebaseRequiredComment(headRefOid: string, integration: string): string {
  return `## Rebase required\nConflicts with \`${integration}\` at \`${headRefOid}\` — GitHub can't build a merge ref, so no checks ran on this diff.`
}

function approvalWithdrawnComment(red: Extract<TickObservation, { readonly kind: 'withdraw-approval' }>['red'], headRefOid: string, escalated: boolean): string {
  const lines = red.map((r) => `\`${r.name ?? 'unknown'}\` went **${r.conclusion ?? 'UNKNOWN'}** on \`${headRefOid}\` after approval.${r.url !== null ? ` ${r.url}` : ''}`)
  const escalation = escalated ? ["This check grades the pull request's own review history, so no revision can change it — escalated to you instead of revision. A new head is the way past it."] : []
  return `## Approval withdrawn\n${[...lines, ...escalation].join('\n')}`
}

/** The write chokepoint's own request shape for one observation. `integration` is
 *  `branches.integration`, for the "Rebase required" comment's own `<base>`. */
export function observationWrite(observation: WriteObservation, item: ReconciledItem, integration: string): ObservationWritePlan {
  switch (observation.kind) {
    case 'liveness-reset':
      return { move: { kind: 'retry' }, action: 'observe-liveness-reset', comment: null }
    case 'cycle-cap': {
      const comment = `${PIPELINE_ESCALATION}\n${String(observation.count)} ${CYCLE_CAP_ESCALATION_MARKER} ${String(observation.cap)} without merging.${escalationMarker('cycle-cap', item.headRefOid)}`
      return { move: { kind: 'escalate', detail: 'cycle-cap' }, action: 'observe-cycle-cap', comment }
    }
    case 'zero-diff': {
      const comment = `${PIPELINE_ESCALATION}\nCycle ${String(observation.count)} was the second review of \`${observation.headRefOid}\`, the most one head gets. A new head is the way past it.${escalationMarker('sha-cap', observation.headRefOid)}`
      return { move: { kind: 'escalate', detail: 'sha-cap' }, action: 'observe-zero-diff', comment }
    }
    case 'integration-red': {
      const names = observation.checks.map((name) => `\`${name}\``).join(', ')
      const comment = `${PIPELINE_ESCALATION}\n\`${integration}\` stayed red on ${names} for 24 hours, so review of \`${observation.headRefOid}\` never resumed.\nThe failure is not from this diff. Fix \`${integration}\`, then refresh the branch.${escalationMarker('integration-red', observation.headRefOid)}`
      return { move: { kind: 'escalate', detail: 'integration-red' }, action: 'observe-integration-red', comment }
    }
    case 'refresh': {
      const comment = observation.cause === 'integration-green' ? null : rebaseRequiredComment(observation.headRefOid, integration)
      return { move: { kind: 'refresh' }, action: 'observe-refresh', comment }
    }
    case 'refresh-stuck': {
      const detail = observation.reason === 'same-sha' ? 'a refresh — a second one would change nothing.' : `${String(observation.count - 1)} consecutive refreshes.`
      const comment = `${PIPELINE_ESCALATION}\nStill conflicting at \`${observation.sha}\` after ${detail}${escalationMarker('refresh-stuck', observation.sha)}`
      return { move: { kind: 'escalate', detail: 'refresh-stuck' }, action: 'observe-refresh-stuck', comment }
    }
    case 'withdraw-approval': {
      const escalated = observation.route === 'human'
      return {
        move: escalated ? { kind: 'escalate', detail: 'approval-withdrawn' } : { kind: 'revise' },
        action: 'observe-withdraw-approval',
        comment: approvalWithdrawnComment(observation.red, observation.headRefOid, escalated),
      }
    }
    case 'plan-missing': {
      const comment = '## Plan missing\nThis issue was at plan review but its body has no `## Implementation Plan` section, so it was moved back to be planned again.'
      return { move: { kind: 'request-plan-changes' }, action: 'observe-plan-missing', comment }
    }
  }
}
