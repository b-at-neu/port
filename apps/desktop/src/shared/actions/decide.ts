// Pure operator-decision derivation — the sibling `decisionsFor` to
// `plan.ts`'s own `actionsFor`.
import type { LabelKey } from '../labels/vocabulary'
import type { AssigneeExpectation, LabelPrecondition } from '../writes/types'
import type { PullRequestCommentNode } from '../github/types'
import type { ReconciledItem } from '../state/types'
import { cycleGrantCount } from '../../../../../scripts/port-tick/gates'
import { CYCLE_CAP_ESCALATION_MARKER, PIPELINE_ESCALATION_HEADING } from './bodies'
import type { DecisionAvailability, DecisionRefusal, OperatorDecision, UnblockRoute } from './types'
import { MAX_REVISE_NOTE_CHARS } from './types'

export interface Escalation {
  readonly reason: string | null
  readonly rebaseDecisions: number
}

const REBASE_DECISION_RE = /^### D\d+\b/

/** The newest escalation comment's reason and open rebase-decision count —
 *  `null`/`0` when none is present, never guessed. */
export function escalationOf(comments: readonly PullRequestCommentNode[] | null): Escalation {
  const candidates = (comments ?? []).filter((c) => c.body.startsWith(PIPELINE_ESCALATION_HEADING))
  if (candidates.length === 0) return { reason: null, rebaseDecisions: 0 }
  const newest = candidates.reduce((a, b) => (Date.parse(b.createdAt) > Date.parse(a.createdAt) ? b : a))
  const lines = newest.body.split('\n')
  const reason = lines.slice(1).find((line) => line.trim() !== '') ?? null
  const rebaseDecisions = lines.filter((line) => REBASE_DECISION_RE.test(line.trim())).length
  return { reason, rebaseDecisions }
}

// Whether the newest escalation was the cycle cap — the one "unblock #N"
// applies its "Grant one more cycle" route to; detected off its own marker.
export function isCycleCapEscalation(comments: readonly PullRequestCommentNode[] | null): boolean {
  const { reason } = escalationOf(comments)
  return reason !== null && reason.includes(CYCLE_CAP_ESCALATION_MARKER)
}

/** `'only-sha'` means every non-empty line merely names the commit. */
export function reviseNoteProblem(note: string, headRefOid: string): 'empty' | 'too-long' | 'only-sha' | null {
  if (note.trim() === '') return 'empty'
  if (note.length > MAX_REVISE_NOTE_CHARS) return 'too-long'
  const nonEmpty = note.split('\n').filter((line) => line.trim() !== '')
  if (nonEmpty.length > 0 && nonEmpty.every((line) => line.includes(headRefOid))) return 'only-sha'
  return null
}

function onlyStage(item: Pick<ReconciledItem, 'stages'>, key: LabelKey): boolean {
  return item.stages.length === 1 && item.stages[0]?.key === key
}

function refused(reason: DecisionRefusal): DecisionAvailability {
  return { available: false, reason }
}

export interface DecisionsForParams {
  readonly item: ReconciledItem
  readonly viewer: string | null
  readonly reviewCycleCap: number
}

/** Ownership requires exactly `[viewer]` — unlike `actionsFor`, no
 *  unassigned exception for these two consequential writes. */
export function decisionsFor(params: DecisionsForParams): Readonly<Record<OperatorDecision, DecisionAvailability>> {
  const { item, viewer, reviewCycleCap } = params
  if (viewer === null) return { unblock: refused('viewer-unknown'), revise: refused('viewer-unknown') }
  if (!(item.assignees.length === 1 && item.assignees[0] === viewer)) return { unblock: refused('not-owned'), revise: refused('not-owned') }

  const cyclesUsed = item.reviewCycleCount ?? 0
  const effectiveCap = reviewCycleCap + cycleGrantCount(item.comments ?? undefined)

  let unblock: DecisionAvailability
  if (item.kind !== 'pull-request' || !onlyStage(item, 'needsHuman')) {
    unblock = refused('not-applicable')
  } else {
    const escalation = escalationOf(item.comments)
    unblock =
      escalation.rebaseDecisions > 0
        ? refused('rebase-decisions')
        : { available: true, context: { reason: escalation.reason, cyclesUsed, cap: effectiveCap } }
  }

  let revise: DecisionAvailability
  if (item.kind !== 'pull-request' || !onlyStage(item, 'approved') || item.headRefOid === null) {
    revise = refused('not-applicable')
  } else {
    revise = cyclesUsed >= effectiveCap ? refused('cycle-cap') : { available: true, context: { headRefOid: item.headRefOid, cyclesUsed, cap: effectiveCap } }
  }

  return { unblock, revise }
}

export interface DecisionPlan {
  readonly add: readonly LabelKey[]
  readonly remove: readonly LabelKey[]
  readonly expect: LabelPrecondition
  readonly action: string
}

function exactAssignees(viewer: string): AssigneeExpectation {
  return { kind: 'exactly', logins: [viewer] }
}

/** Call only once `decisionsFor` reports `available: true` for this item. */
export function decisionPlan(decision: OperatorDecision, item: ReconciledItem, route: UnblockRoute | null, viewer: string): DecisionPlan {
  if (decision === 'unblock') {
    const add: LabelKey = route === 'revision' ? 'needsRevision' : 'readyForReview'
    return { add: [add], remove: ['needsHuman'], expect: { present: ['needsHuman'], absent: [], assignees: exactAssignees(viewer) }, action: 'unblock' }
  }
  return { add: ['needsRevision'], remove: ['approved'], expect: { present: ['approved'], absent: [], assignees: exactAssignees(viewer) }, action: 'revise' }
}
