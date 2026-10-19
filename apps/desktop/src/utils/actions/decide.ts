// Pure operator-decision derivation — the sibling `decisionsFor` to
// `plan.ts`'s own `actionsFor`.
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { AssigneeExpectation, LabelPrecondition } from '@/types/writes'
import type { PullRequestCommentNode } from '@/types/github'
import type { ReconciledItem } from '@/types/state'
import { cycleGrantCount } from '../../../../../scripts/port-tick/gates'
import { CYCLE_CAP_ESCALATION_MARKER, PIPELINE_ESCALATION_HEADING } from '@/utils/actions/bodies'
import type { DecisionAvailability, DecisionRefusal, OperatorDecision, RebaseDecision, RebaseOption, RebasePick, UnblockRoute } from '@/types/actions'
import { MAX_REVISE_NOTE_CHARS } from '@/types/actions'

export interface Escalation {
  readonly reason: string | null
  readonly rebaseDecisions: readonly RebaseDecision[] | 'unparseable'
}

const REBASE_DECISION_RE = /^### (D\d+)\b/
const OPTION_PATTERNS = [/^\*\*([A-Z])\*\*\s*(?:[—–:.)-]\s*)?(.+)$/, /^\*\*([A-Z])\s+(.+?)\*\*$/, /^([A-Z])\s*[—–:.)-]\s*(.+)$/, /^([A-Z])\s+(.+)$/]

function optionOf(cell: string): RebaseOption | null {
  for (const pattern of OPTION_PATTERNS) {
    const match = pattern.exec(cell.trim())
    if (match === null) continue
    const label = (match[2] ?? '').replaceAll('**', '').trim()
    return label === '' ? null : { letter: match[1] ?? '', label }
  }
  return null
}

function isSeparatorRow(row: string): boolean {
  return /^\|[\s:|-]+$/.test(row)
}

function decisionOf(id: string, block: readonly string[]): RebaseDecision | null {
  const path = /`([^`]+)`/.exec(block[0] ?? '')?.[1]
  if (path === undefined) return null
  const rows = block.filter((line) => line.startsWith('|'))
  const separator = rows.findIndex(isSeparatorRow)
  if (separator === -1) return null
  const options: RebaseOption[] = []
  for (const row of rows.slice(separator + 1)) {
    const option = optionOf(row.split('|')[1] ?? '')
    if (option === null) return null
    options.push(option)
  }
  if (options.length < 2 || new Set(options.map((o) => o.letter)).size !== options.length) return null
  const recommendation = /\*\*Recommendation:\s*([A-Z])\*\*/.exec(block.join('\n'))?.[1] ?? null
  const summary = block.slice(1).find((line) => line !== '' && !line.startsWith('|') && !/\*\*Recommendation:/.test(line)) ?? null
  return { id, path, summary, options, recommended: options.some((o) => o.letter === recommendation) ? recommendation : null }
}

/** Every `### D<n>` block of an escalation body; `'unparseable'` when any block can't be read exactly, never a guess. */
export function rebaseDecisionsOf(body: string): readonly RebaseDecision[] | 'unparseable' {
  const lines = body.split('\n').map((line) => line.trim())
  const decisions: RebaseDecision[] = []
  for (let start = 0; start < lines.length; start++) {
    const id = REBASE_DECISION_RE.exec(lines[start] ?? '')?.[1]
    if (id === undefined) continue
    let end = start + 1
    while (end < lines.length && !/^#{1,3} /.test(lines[end] ?? '')) end++
    const decision = decisionOf(id, lines.slice(start, end))
    if (decision === null) return 'unparseable'
    decisions.push(decision)
  }
  return new Set(decisions.map((d) => d.id)).size === decisions.length ? decisions : 'unparseable'
}

/** The newest escalation comment's reason and rebase decisions — `null`/`[]` when none is present, never guessed. */
export function escalationOf(comments: readonly PullRequestCommentNode[] | null): Escalation {
  const candidates = (comments ?? []).filter((c) => c.body.startsWith(PIPELINE_ESCALATION_HEADING))
  if (candidates.length === 0) return { reason: null, rebaseDecisions: [] }
  const newest = candidates.reduce((a, b) => (Date.parse(b.createdAt) > Date.parse(a.createdAt) ? b : a))
  const reason = newest.body.split('\n').slice(1).find((line) => line.trim() !== '') ?? null
  return { reason, rebaseDecisions: rebaseDecisionsOf(newest.body) }
}

/** One pick per decision that has one, in the escalation's own order. */
export function pickList(decisions: readonly RebaseDecision[], chosen: Readonly<Record<string, string>>): readonly RebasePick[] {
  return decisions.flatMap((d) => {
    const letter = chosen[d.id]
    return letter === undefined ? [] : [{ id: d.id, letter }]
  })
}

/** Why `picks` can't answer `decisions` — exactly one pick per decision, each an offered letter — or `null` when it can. */
export function picksProblem(decisions: readonly RebaseDecision[], picks: readonly RebasePick[]): string | null {
  const seen = new Set<string>()
  for (const pick of picks) {
    const decision = decisions.find((d) => d.id === pick.id)
    if (decision === undefined) return `unknown ${pick.id}`
    if (seen.has(pick.id)) return `duplicate ${pick.id}`
    seen.add(pick.id)
    if (!decision.options.some((o) => o.letter === pick.letter)) return `off-menu ${pick.id}`
  }
  const missing = decisions.find((d) => !seen.has(d.id))
  return missing === undefined ? null : `missing ${missing.id}`
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
  /** Whether a live hosted stage session exists for this item — a blocked issue then belongs to that session's own answer path. */
  readonly liveStage: boolean
}

/** Ownership requires exactly `[viewer]` — unlike `actionsFor`, no
 *  unassigned exception for these two consequential writes. */
export function decisionsFor(params: DecisionsForParams): Readonly<Record<OperatorDecision, DecisionAvailability>> {
  const { item, viewer, reviewCycleCap, liveStage } = params
  if (viewer === null) return { unblock: refused('viewer-unknown'), revise: refused('viewer-unknown') }
  if (!(item.assignees.length === 1 && item.assignees[0] === viewer)) return { unblock: refused('not-owned'), revise: refused('not-owned') }

  const cyclesUsed = item.reviewCycleCount ?? 0
  const effectiveCap = reviewCycleCap + cycleGrantCount(item.comments ?? undefined)

  let unblock: DecisionAvailability
  if (item.kind === 'issue' && onlyStage(item, 'blocked')) {
    unblock = liveStage ? refused('agent-live') : { available: true, context: { target: 'issue', reason: null, cyclesUsed: 0, cap: 0, decisions: [] } }
  } else if (item.kind !== 'pull-request' || !onlyStage(item, 'needsHuman')) {
    unblock = refused('not-applicable')
  } else {
    const escalation = escalationOf(item.comments)
    unblock =
      escalation.rebaseDecisions === 'unparseable'
        ? refused('rebase-decisions')
        : { available: true, context: { target: 'pull-request', reason: escalation.reason, cyclesUsed, cap: effectiveCap, decisions: escalation.rebaseDecisions } }
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
    if (route === 'implementation') {
      return { add: ['planApproved'], remove: ['blocked'], expect: { present: ['blocked'], absent: [], assignees: exactAssignees(viewer) }, action: 'unblock' }
    }
    const add: LabelKey = route === 'revision' ? 'needsRevision' : 'readyForReview'
    return { add: [add], remove: ['needsHuman'], expect: { present: ['needsHuman'], absent: [], assignees: exactAssignees(viewer) }, action: 'unblock' }
  }
  return { add: ['needsRevision'], remove: ['approved'], expect: { present: ['approved'], absent: [], assignees: exactAssignees(viewer) }, action: 'revise' }
}
