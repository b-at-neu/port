import { gateSchema, queueReasonSchema, STAGES, STATUS_KINDS } from '@/utils/pipeline/ticket'
import type { Gate, QueueReason, Stage, Status, StatusKind } from '@/utils/pipeline/ticket'
import { PHASE_KEYS } from '@/types/board'
import type { BoardColumnKey, BoardSectionKey, PhaseKey, PhaseSegment, RowNeedsYouKind } from '@/types/board'
import type { StageAgent } from '@/types/tick'
import type { AssertEqual } from '@/types/assert-type'
import type { LabelPalette } from '@/utils/labels/defaults'

export type StageStatus =
  | { readonly kind: 'queued'; readonly reason: QueueReason }
  | { readonly kind: 'waiting-on-you'; readonly gate: Gate }
  | { readonly kind: Exclude<StatusKind, 'queued' | 'waiting-on-you'> }

export interface TicketView {
  readonly stage: Stage
  readonly status: StageStatus
}

export interface StageRow {
  readonly name: string
  readonly phase: PhaseKey | null
  readonly column: BoardColumnKey
  readonly needsYou: RowNeedsYouKind | null
  readonly palette: LabelPalette | null
  readonly agent: StageAgent | null
  readonly attention: boolean
}

export const _statusAssignableToStageStatus: AssertEqual<[Status] extends [StageStatus] ? true : false, true> = true

function row(name: string, phase: PhaseKey, column: BoardColumnKey, needsYou: RowNeedsYouKind | null, palette: LabelPalette, agent: StageAgent | null, attention = false): StageRow {
  return { name, phase, column, needsYou, palette, agent, attention }
}

interface StageCells {
  readonly queued: StageRow
  readonly running: StageRow
  readonly waiting: StageRow
  readonly blocked: StageRow
  readonly column: BoardColumnKey
}

function cellsOf({ queued, running, waiting, blocked, column }: StageCells): Record<StatusKind, StageRow> {
  return { queued, held: queued, running, 'waiting-on-you': waiting, blocked, done: row('Merged', 'merge', column, null, 'done', null) }
}

export const STAGE_TABLE: Readonly<Record<Stage, Readonly<Record<StatusKind, StageRow>>>> = {
  plan: cellsOf({
    column: 'plan',
    queued: row('Queued', 'plan', 'queued', null, 'plan', 'plan'),
    running: row('Planning', 'plan', 'plan', null, 'plan', 'plan'),
    waiting: row('Plan review', 'plan', 'plan', 'plan-review', 'plan', null),
    blocked: row('Blocked', 'plan', 'queued', 'blocked', 'needs-you', null, true),
  }),
  implement: cellsOf({
    column: 'implement',
    queued: row('Plan approved', 'implement', 'implement', null, 'implement', 'impl'),
    running: row('Implementing', 'implement', 'implement', null, 'implement', 'impl'),
    waiting: row('Needs you', 'implement', 'implement', 'needs-human', 'needs-you', null, true),
    blocked: row('Blocked', 'implement', 'queued', 'blocked', 'needs-you', null, true),
  }),
  review: cellsOf({
    column: 'review',
    queued: row('Waiting for review', 'review', 'review', null, 'review', 'review'),
    running: row('Reviewing', 'review', 'review', null, 'review', 'review'),
    waiting: row('Needs you', 'review', 'review', 'needs-human', 'needs-you', null, true),
    blocked: row('Blocked', 'review', 'queued', 'blocked', 'needs-you', null, true),
  }),
  revise: cellsOf({
    column: 'revise',
    queued: row('Needs revision', 'revision', 'revise', null, 'revise', 'revise'),
    running: row('Revising', 'revision', 'revise', null, 'revise', 'revise'),
    waiting: row('Needs you', 'revision', 'revise', 'needs-human', 'needs-you', null, true),
    blocked: row('Blocked', 'revision', 'queued', 'blocked', 'needs-you', null, true),
  }),
  refresh: cellsOf({
    column: 'revise',
    queued: row('Refreshing', 'revision', 'revise', null, 'refresh', 'revise'),
    running: row('Refreshing', 'revision', 'revise', null, 'refresh', 'revise'),
    waiting: row('Needs you', 'revision', 'revise', 'needs-human', 'needs-you', null, true),
    blocked: row('Blocked', 'revision', 'queued', 'blocked', 'needs-you', null, true),
  }),
  merge: cellsOf({
    column: 'needs-you',
    queued: row('Ready to merge', 'merge', 'needs-you', null, 'done', null),
    running: row('Ready to merge', 'merge', 'needs-you', null, 'done', null),
    waiting: row('Ready to merge', 'merge', 'needs-you', 'ready-to-merge', 'done', null),
    blocked: row('Blocked', 'merge', 'queued', 'blocked', 'needs-you', null, true),
  }),
}

const QUEUE_REFINE: Readonly<Partial<Record<Stage, Readonly<Partial<Record<QueueReason, Partial<StageRow>>>>>>> = {
  plan: { 'changes-requested': { name: 'Replanning', column: 'plan' } },
}

const GATE_REFINE: Readonly<Record<Gate, Partial<StageRow>>> = {
  'plan-approval': { needsYou: 'plan-review' },
  merge: { needsYou: 'ready-to-merge' },
  escalation: { name: 'Needs you', needsYou: 'needs-human', palette: 'needs-you', attention: true },
  question: { name: 'Needs you', needsYou: null, palette: 'needs-you', attention: true },
  permission: { name: 'Needs you', needsYou: null, palette: 'needs-you', attention: true },
  interrupted: { name: 'Needs you', needsYou: null, palette: 'needs-you', attention: true },
}

export const PHASE_TABLE: Readonly<Record<PhaseKey, { readonly name: string; readonly palette: LabelPalette }>> = {
  plan: { name: 'Planning', palette: 'plan' },
  implement: { name: 'Implementing', palette: 'implement' },
  review: { name: 'Reviewing', palette: 'review' },
  revision: { name: 'Revising', palette: 'revise' },
  merge: { name: 'Ready to merge', palette: 'done' },
}

const UNSTAGED_ROW: StageRow = { name: 'Unstaged', phase: null, column: 'queued', needsYou: null, palette: null, agent: null, attention: false }

export function stageRowOf(view: TicketView | null): StageRow {
  if (view === null) return UNSTAGED_ROW
  const { stage, status } = view
  const cell = STAGE_TABLE[stage][status.kind]
  if (status.kind === 'queued') return { ...cell, ...QUEUE_REFINE[stage]?.[status.reason] }
  if (status.kind === 'waiting-on-you') return { ...cell, ...GATE_REFINE[status.gate] }
  return cell
}

export function stageNameOf(view: TicketView | null): string {
  return stageRowOf(view).name
}

export function phaseOf(view: TicketView | null): PhaseKey | null {
  return stageRowOf(view).phase
}

export function waitsOnYou(view: TicketView | null, autoApproving: boolean): boolean {
  return view?.status.kind === 'waiting-on-you' && !autoApproving
}

interface ColumnContext {
  readonly autoApproving: boolean
  readonly blocked: boolean
}

export function columnOf(view: TicketView | null, { autoApproving, blocked }: ColumnContext): BoardColumnKey {
  if (waitsOnYou(view, autoApproving)) return 'needs-you'
  if (blocked) return 'queued'
  return stageRowOf(view).column
}

interface SectionContext extends ColumnContext {
  readonly working: boolean
}

export function sectionOf(view: TicketView | null, { autoApproving, blocked, working }: SectionContext): BoardSectionKey {
  if (waitsOnYou(view, autoApproving)) return 'waiting-on-you'
  if (blocked) return 'blocked'
  if (autoApproving || working) return 'in-progress'
  return 'queued'
}

export function needsYouKindOf(view: TicketView | null, autoApproving: boolean): RowNeedsYouKind | null {
  return autoApproving ? null : stageRowOf(view).needsYou
}

export function phaseSegmentsOf(view: TicketView | null): readonly PhaseSegment[] {
  if (view?.status.kind === 'done') return PHASE_KEYS.map((phase) => ({ phase, state: 'complete' as const, palette: 'done' as const }))

  const { phase: current, palette, attention } = stageRowOf(view)
  const currentPos = current !== null ? PHASE_KEYS.indexOf(current) : -1

  return PHASE_KEYS.map((phase, index): PhaseSegment => {
    if (current === null || index > currentPos) return { phase, state: 'pending', palette: null }
    if (index < currentPos) return { phase, state: 'finished', palette: PHASE_TABLE[phase].palette }
    return { phase, state: attention ? 'current-attention' : 'current-working', palette }
  })
}

const UNSTAGED_RANK = Number.MAX_SAFE_INTEGER

export function stageGroupOf(view: TicketView | null): { readonly key: string; readonly rank: number } {
  if (view === null) return { key: 'unstaged', rank: UNSTAGED_RANK }
  const { stage, status } = view
  const detail = status.kind === 'queued' ? status.reason : status.kind === 'waiting-on-you' ? status.gate : null
  const detailRank = status.kind === 'queued' ? queueReasonSchema.options.indexOf(status.reason) : status.kind === 'waiting-on-you' ? gateSchema.options.indexOf(status.gate) : 0
  return {
    key: detail === null ? `${stage}:${status.kind}` : `${stage}:${status.kind}:${detail}`,
    rank: STAGES.indexOf(stage) * 10_000 + STATUS_KINDS.indexOf(status.kind) * 100 + detailRank,
  }
}

/** The view of a ticket — its stage and the identifying part of its status, which is all an operator action's `expected` compares. */
export function ticketViewOf(ticket: { readonly stage: Stage; readonly status: Status }): TicketView {
  const { stage, status } = ticket
  if (status.kind === 'queued') return { stage, status: { kind: 'queued', reason: status.reason } }
  if (status.kind === 'waiting-on-you') return { stage, status: { kind: 'waiting-on-you', gate: status.gate } }
  return { stage, status: { kind: status.kind } }
}

export function agentStage(agent: StageAgent): Stage {
  return STAGES.find((stage) => STAGE_TABLE[stage].running.agent === agent) ?? 'plan'
}

export function agentStageName(agent: StageAgent): string {
  return STAGE_TABLE[agentStage(agent)].running.name
}

export function agentPhase(agent: StageAgent): PhaseKey {
  return STAGE_TABLE[agentStage(agent)].running.phase ?? 'plan'
}
