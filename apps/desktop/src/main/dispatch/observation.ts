// Pure: one machine-observation write's label plan, precondition, and comment body.
// Mirrors scripts/port-tick/writes.ts exactly, pinned by scripts/checks/desktop-dispatch.ts.
import type { LabelKey, LabelVocabulary } from '../../shared/labels/vocabulary'
import type { ReconciledItem } from '../../shared/state/types'
import type { TickObservation } from '../../shared/tick/types'

// A literal, not an import — this module loads standalone and can't resolve a relative import.
const CYCLE_CAP_ESCALATION_MARKER = 'review cycles reached the cap of'

/** Every `TickObservation` kind this module writes — excludes the one report-only kind, `refresh-deferred`. */
export type WriteObservation = Exclude<TickObservation, { readonly kind: 'refresh-deferred' }>

export interface ObservationWritePlan {
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

function rebaseRequiredComment(headRefOid: string, integration: string): string {
  return `## Rebase required\nConflicts with \`${integration}\` at \`${headRefOid}\` — GitHub can't build a merge ref, so no checks ran on this diff.`
}

function approvalWithdrawnComment(red: Extract<TickObservation, { readonly kind: 'withdraw-approval' }>['red'], headRefOid: string): string {
  const lines = red.map((r) => `\`${r.name ?? 'unknown'}\` went **${r.conclusion ?? 'UNKNOWN'}** on \`${headRefOid}\` after approval.${r.url !== null ? ` ${r.url}` : ''}`)
  return `## Approval withdrawn\n${lines.join('\n')}`
}

/** The write chokepoint's own request shape for one observation. `integration` is
 *  `branches.integration`, for the "Rebase required" comment's own `<base>`. */
export function observationWrite(observation: WriteObservation, item: ReconciledItem, vocabulary: LabelVocabulary, integration: string): ObservationWritePlan {
  switch (observation.kind) {
    case 'liveness-reset': {
      const add: readonly LabelKey[] = [observation.retryKey]
      return { add, remove: [observation.inFlight], expect: precondition(item, vocabulary, add), action: 'observe-liveness-reset', comment: null }
    }
    case 'cycle-cap': {
      const add: readonly LabelKey[] = ['needsHuman']
      const comment = `${PIPELINE_ESCALATION}\n${String(observation.count)} ${CYCLE_CAP_ESCALATION_MARKER} ${String(observation.cap)} without merging.`
      return { add, remove: ['needsRevision'], expect: precondition(item, vocabulary, add), action: 'observe-cycle-cap', comment }
    }
    case 'zero-diff': {
      const add: readonly LabelKey[] = ['needsHuman']
      const comment = `${PIPELINE_ESCALATION}\nCycle ${String(observation.count)} already reviewed \`${observation.headRefOid}\` and the head has not moved, so no new review cycle was opened.\nWhatever is blocking this pull request is not visible to review or revision.`
      return { add, remove: ['readyForReview'], expect: precondition(item, vocabulary, add), action: 'observe-zero-diff', comment }
    }
    case 'refresh': {
      const add: readonly LabelKey[] = ['refreshBranch']
      return { add, remove: [], expect: precondition(item, vocabulary, add), action: 'observe-refresh', comment: rebaseRequiredComment(observation.headRefOid, integration) }
    }
    case 'refresh-stuck': {
      const add: readonly LabelKey[] = ['needsHuman']
      const detail =
        observation.reason === 'same-sha'
          ? 'a refresh — a second one would change nothing.'
          : `${String(observation.count - 1)} consecutive refreshes.`
      const comment = `${PIPELINE_ESCALATION}\nStill conflicting at \`${observation.sha}\` after ${detail}`
      return { add, remove: [observation.sourceLabel], expect: precondition(item, vocabulary, add), action: 'observe-refresh-stuck', comment }
    }
    case 'withdraw-approval': {
      const add: readonly LabelKey[] = ['needsRevision']
      return { add, remove: ['approved'], expect: precondition(item, vocabulary, add), action: 'observe-withdraw-approval', comment: approvalWithdrawnComment(observation.red, observation.headRefOid) }
    }
  }
}
