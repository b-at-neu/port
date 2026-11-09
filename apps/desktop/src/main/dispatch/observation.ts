// Pure: one machine-observation write's label plan, precondition, and comment body.
// Mirrors scripts/port-tick/writes.ts exactly, pinned by scripts/checks/desktop-dispatch.ts.
import type { LabelKey, LabelVocabulary } from '@/utils/labels/vocabulary'
import type { ReconciledItem } from '@/types/state'
import type { TickObservation } from '@/types/tick'
import type { WriteObservation } from '@/types/dispatch'

// A literal, not an import — this module loads standalone and can't resolve a relative import.
const CYCLE_CAP_ESCALATION_MARKER = 'review cycles reached the cap of'

interface ObservationWritePlan {
  readonly add: readonly LabelKey[]
  readonly remove: readonly LabelKey[]
  readonly expect: {
    readonly present: readonly LabelKey[]
    readonly absent: readonly LabelKey[]
    readonly assignees: { readonly kind: 'exactly'; readonly logins: readonly string[] }
  }
  readonly action: string
  readonly comment: string | null
}

function precondition(item: ReconciledItem, vocabulary: LabelVocabulary, add: readonly LabelKey[]): ObservationWritePlan['expect'] {
  const present = item.stages.filter((s) => s.role !== 'marker').map((s) => s.key)
  const allRoleBearing = vocabulary.labels.filter((l) => l.role !== 'marker').map((l) => l.key)
  const absent = allRoleBearing.filter((key) => !present.includes(key) && !add.includes(key))
  return { present, absent, assignees: { kind: 'exactly', logins: item.assignees } }
}

const PIPELINE_ESCALATION = '## Pipeline Escalation'

// A literal mirror of gates.ts's `escalationMarker`, pinned by scripts/checks/desktop-dispatch.ts.
function escalationMarker(cause: 'zero-diff' | 'sha-cap' | 'cycle-cap' | 'integration-red' | 'refresh-stuck', sha: string | null): string {
  return `\n<!-- port:escalation ${cause} ${sha ?? ''} -->`
}

function rebaseRequiredComment(headRefOid: string, integration: string): string {
  return `## Rebase required\nConflicts with \`${integration}\` at \`${headRefOid}\` — GitHub can't build a merge ref, so no checks ran on this diff.`
}

function approvalWithdrawnComment(red: Extract<TickObservation, { readonly kind: 'withdraw-approval' }>['red'], headRefOid: string, needsHuman: string | null): string {
  const lines = red.map((r) => `\`${r.name ?? 'unknown'}\` went **${r.conclusion ?? 'UNKNOWN'}** on \`${headRefOid}\` after approval.${r.url !== null ? ` ${r.url}` : ''}`)
  const escalation = needsHuman === null ? [] : [`This check grades the pull request's own review history, so no revision can change it — moved to \`${needsHuman}\` instead of revision. A new head is the way past it.`]
  return `## Approval withdrawn\n${[...lines, ...escalation].join('\n')}`
}

/** The write chokepoint's own request shape for one observation. `integration` is
 *  `branches.integration`, for the "Rebase required" comment's own `<base>`. */
export function observationWrite(observation: WriteObservation, item: ReconciledItem, vocabulary: LabelVocabulary, integration: string): ObservationWritePlan {
  switch (observation.kind) {
    case 'liveness-reset': {
      const add: readonly LabelKey[] = [observation.retryKey]
      const action = observation.evidence === 'stage-error' ? 'observe-stage-error-reset' : 'observe-liveness-reset'
      return { add, remove: [observation.inFlight], expect: precondition(item, vocabulary, add), action, comment: null }
    }
    case 'cycle-cap': {
      const add: readonly LabelKey[] = ['needsHuman']
      const comment = `${PIPELINE_ESCALATION}\n${String(observation.count)} ${CYCLE_CAP_ESCALATION_MARKER} ${String(observation.cap)} without merging.${escalationMarker('cycle-cap', item.headRefOid)}`
      return { add, remove: ['needsRevision'], expect: precondition(item, vocabulary, add), action: 'observe-cycle-cap', comment }
    }
    case 'zero-diff': {
      const add: readonly LabelKey[] = ['needsHuman']
      const comment =
        observation.reason === 'sha-cap'
          ? `${PIPELINE_ESCALATION}\nCycle ${String(observation.count)} was the second review of \`${observation.headRefOid}\`, the most one head gets. A new head is the way past it.${escalationMarker('sha-cap', observation.headRefOid)}`
          : `${PIPELINE_ESCALATION}\nCycle ${String(observation.count)} already reviewed \`${observation.headRefOid}\` and the head has not moved, so no new review cycle was opened.\nWhatever is blocking this pull request is not visible to review or revision.${escalationMarker('zero-diff', observation.headRefOid)}`
      return { add, remove: ['readyForReview'], expect: precondition(item, vocabulary, add), action: 'observe-zero-diff', comment }
    }
    case 'integration-red': {
      const add: readonly LabelKey[] = ['needsHuman']
      const names = observation.checks.map((name) => `\`${name}\``).join(', ')
      const comment = `${PIPELINE_ESCALATION}\n\`${integration}\` stayed red on ${names} for 24 hours, so review of \`${observation.headRefOid}\` never resumed.\nThe failure is not from this diff. Fix \`${integration}\`, then refresh the branch.${escalationMarker('integration-red', observation.headRefOid)}`
      return { add, remove: ['readyForReview'], expect: precondition(item, vocabulary, add), action: 'observe-integration-red', comment }
    }
    case 'refresh': {
      const add: readonly LabelKey[] = ['refreshBranch']
      const remove: readonly LabelKey[] = observation.sourceLabel === 'readyForReview' ? ['readyForReview'] : []
      const comment = observation.cause === 'integration-green' ? null : rebaseRequiredComment(observation.headRefOid, integration)
      return { add, remove, expect: precondition(item, vocabulary, add), action: 'observe-refresh', comment }
    }
    case 'refresh-stuck': {
      const add: readonly LabelKey[] = ['needsHuman']
      const detail =
        observation.reason === 'same-sha'
          ? 'a refresh — a second one would change nothing.'
          : `${String(observation.count - 1)} consecutive refreshes.`
      const comment = `${PIPELINE_ESCALATION}\nStill conflicting at \`${observation.sha}\` after ${detail}${escalationMarker('refresh-stuck', observation.sha)}`
      return { add, remove: [observation.sourceLabel], expect: precondition(item, vocabulary, add), action: 'observe-refresh-stuck', comment }
    }
    case 'withdraw-approval': {
      if (observation.route === 'human') {
        const humanAdd: readonly LabelKey[] = ['needsHuman']
        const needsHumanName = vocabulary.labels.find((l) => l.key === 'needsHuman')?.name ?? 'needsHuman'
        return { add: humanAdd, remove: ['approved'], expect: precondition(item, vocabulary, humanAdd), action: 'observe-withdraw-approval', comment: approvalWithdrawnComment(observation.red, observation.headRefOid, needsHumanName) }
      }
      const add: readonly LabelKey[] = ['needsRevision']
      return { add, remove: ['approved'], expect: precondition(item, vocabulary, add), action: 'observe-withdraw-approval', comment: approvalWithdrawnComment(observation.red, observation.headRefOid, null) }
    }
    case 'plan-missing': {
      const add: readonly LabelKey[] = ['ready']
      const planReviewName = vocabulary.labels.find((l) => l.key === 'planReview')?.name ?? 'planReview'
      const readyName = vocabulary.labels.find((l) => l.key === 'ready')?.name ?? 'ready'
      const comment = `## Plan missing\nThis issue was at \`${planReviewName}\` but its body has no \`## Implementation Plan\` section, so it was moved back to \`${readyName}\` to be planned again.`
      return { add, remove: ['planReview'], expect: precondition(item, vocabulary, add), action: 'observe-plan-missing', comment }
    }
  }
}
