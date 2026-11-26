// Pure operator-decision derivation — the sibling `decisionsFor` to
// `plan.ts`'s own `actionsFor`.
import type { PullRequestCommentNode } from '@/types/github'
import type { ReconciledItem } from '@/types/state'
import { cycleGrantCount } from '@/utils/pipeline/gates'
import type { TicketView } from '@/utils/pipeline/stages'
import type { Gate, Stage } from '@/utils/pipeline/ticket'
import { CYCLE_CAP_ESCALATION_MARKER, PIPELINE_ESCALATION_HEADING } from '@/utils/actions/bodies'
import type { DecisionAvailability, DecisionRefusal, OperatorDecision, OperatorMove, RebaseDecision, RebaseOption, RebasePick, UnblockRoute } from '@/types/actions'
import { MAX_REVISE_NOTE_CHARS } from '@/types/actions'

export interface Escalation {
  readonly reason: string | null
  /** The marker's cause, `null` when the newest escalation carries none. */
  readonly cause: string | null
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

/** The newest escalation comment's reason, marker cause and rebase decisions — `null`/`[]` when none is present, never guessed. */
export function escalationOf(comments: readonly PullRequestCommentNode[] | null): Escalation {
  const candidates = (comments ?? []).filter((c) => c.body.startsWith(PIPELINE_ESCALATION_HEADING))
  if (candidates.length === 0) return { reason: null, cause: null, rebaseDecisions: [] }
  const newest = candidates.reduce((a, b) => (Date.parse(b.createdAt) > Date.parse(a.createdAt) ? b : a))
  const reason = newest.body.split('\n').slice(1).find((line) => line.trim() !== '') ?? null
  const cause = /<!-- port:escalation (\S+)/.exec(newest.body)?.[1] ?? null
  return { reason, cause, rebaseDecisions: rebaseDecisionsOf(newest.body) }
}

function routesOf(escalation: Escalation): readonly UnblockRoute[] {
  if (escalation.rebaseDecisions.length > 0 || escalation.cause === 'sha-cap') return ['revision']
  return ['review', 'revision']
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

function atGate(view: TicketView | null, stage: Stage, gate: Gate): boolean {
  return view?.stage === stage && view.status.kind === 'waiting-on-you' && view.status.gate === gate
}

function refused(reason: DecisionRefusal): DecisionAvailability {
  return { available: false, reason }
}

export interface DecisionsForParams {
  readonly view: TicketView | null
  readonly item: ReconciledItem
  readonly viewer: string | null
  readonly reviewCycleCap: number
  /** Whether a live hosted stage session exists for this item — a blocked issue then belongs to that session's own answer path. */
  readonly liveStage: boolean
}

/** Ownership requires exactly `[viewer]` — unlike `actionsFor`, no
 *  unassigned exception for these two consequential writes. */
export function decisionsFor(params: DecisionsForParams): Readonly<Record<OperatorDecision, DecisionAvailability>> {
  const { view, item, viewer, reviewCycleCap, liveStage } = params
  if (viewer === null) return { unblock: refused('viewer-unknown'), revise: refused('viewer-unknown'), grant: refused('viewer-unknown') }
  if (!(item.assignees.length === 1 && item.assignees[0] === viewer)) return { unblock: refused('not-owned'), revise: refused('not-owned'), grant: refused('not-owned') }

  const cyclesUsed = item.reviewCycleCount ?? 0
  const effectiveCap = reviewCycleCap + cycleGrantCount(item.comments ?? undefined)

  let unblock: DecisionAvailability
  if (item.kind === 'issue' && view?.stage === 'implement' && view.status.kind === 'blocked') {
    unblock = liveStage ? refused('agent-live') : { available: true, context: { target: 'issue', reason: null, cyclesUsed: 0, cap: 0, decisions: [], routes: ['implementation'] } }
  } else if (item.kind !== 'pull-request' || view?.status.kind !== 'waiting-on-you' || view.status.gate !== 'escalation') {
    unblock = refused('not-applicable')
  } else {
    const escalation = escalationOf(item.comments)
    unblock =
      escalation.rebaseDecisions === 'unparseable'
        ? refused('rebase-decisions')
        : { available: true, context: { target: 'pull-request', reason: escalation.reason, cyclesUsed, cap: effectiveCap, decisions: escalation.rebaseDecisions, routes: routesOf(escalation) } }
  }

  let revise: DecisionAvailability
  if (item.kind !== 'pull-request' || !atGate(view, 'merge', 'merge') || item.headRefOid === null) {
    revise = refused('not-applicable')
  } else {
    revise = cyclesUsed >= effectiveCap ? refused('cycle-cap') : { available: true, context: { headRefOid: item.headRefOid, cyclesUsed, cap: effectiveCap } }
  }

  let grant: DecisionAvailability
  const queuedRevision = view?.stage === 'revise' && view.status.kind === 'queued' && view.status.reason === 'changes-requested'
  if (item.kind !== 'pull-request' || !queuedRevision || cyclesUsed < effectiveCap) {
    grant = refused('not-applicable')
  } else {
    grant = liveStage ? refused('agent-live') : { available: true, context: { cyclesUsed, cap: effectiveCap } }
  }

  return { unblock, revise, grant }
}

/** Call only once `decisionsFor` reports `available: true` for this item. */
export function decisionPlan(decision: OperatorDecision, route: UnblockRoute | null): OperatorMove {
  if (decision === 'unblock') return { kind: 'unblock', route: route ?? 'review' }
  return { kind: decision }
}
