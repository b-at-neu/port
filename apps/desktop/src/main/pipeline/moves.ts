// Pure: what each operator move makes of a ticket, keyed on the move and the status it leaves. A source the move does not name is `null`, which the table reports as `not-applicable`.
import type { OperatorMove } from '@/types/actions'
import { queueReasonSchema } from '@/utils/pipeline/ticket'
import type { QueueReason, Stage, Status, Ticket } from '@/utils/pipeline/ticket'

export interface MoveNext {
  readonly stage: Stage
  readonly status: Status
  readonly pr?: Ticket['pr']
}

type MoveOf<K extends OperatorMove['kind']> = Extract<OperatorMove, { readonly kind: K }>
type MoveTable = { readonly [K in OperatorMove['kind']]: (ticket: Ticket, move: MoveOf<K>, at: string) => MoveNext | null }

const queued = (at: string, reason: QueueReason): Status => ({ kind: 'queued', reason, since: at })
const held = (detail: string): Status => ({ kind: 'held', on: 'paused', detail })

/** The queue reason a pause recorded, or `retry` for a detail that names none. */
function reasonOf(detail: string): QueueReason {
  const parsed = queueReasonSchema.safeParse(detail)
  return parsed.success ? parsed.data : 'retry'
}

/** A pull request stage a refresh may interrupt: a review or revision waiting its turn, or an approved merge. */
function refreshable(ticket: Ticket): boolean {
  if (ticket.pr === null) return false
  const { stage, status } = ticket
  if (stage === 'review' || stage === 'revise') return status.kind === 'queued'
  return stage === 'merge' && status.kind === 'waiting-on-you' && status.gate === 'merge'
}

export const OPERATOR_MOVES: MoveTable = {
  pause: ({ stage, status }) => {
    if (status.kind === 'queued') return { stage, status: held(status.reason) }
    return status.kind === 'held' && status.on !== 'paused' ? { stage, status: held(status.detail) } : null
  },
  resume: ({ stage, status }, _move, at) => (status.kind === 'held' && status.on === 'paused' ? { stage, status: queued(at, reasonOf(status.detail)) } : null),
  retry: ({ stage, status }, _move, at) => (status.kind === 'running' ? { stage, status: queued(at, 'retry') } : null),
  stop: ({ stage, status }) => (status.kind === 'running' ? { stage, status: held('retry') } : null),
  refresh: (ticket, _move, at) => (refreshable(ticket) ? { stage: 'refresh', status: queued(at, 'new') } : null),
  unblock: ({ stage, status }, { route }, at) => {
    if (route === 'implementation') return stage === 'implement' && status.kind === 'blocked' ? { stage: 'implement', status: queued(at, 'new') } : null
    if (status.kind !== 'waiting-on-you' || status.gate !== 'escalation') return null
    return route === 'review' ? { stage: 'review', status: queued(at, 'new') } : { stage: 'revise', status: queued(at, 'changes-requested') }
  },
  revise: ({ stage, status, pr }, _move, at) => {
    if (stage !== 'merge' || status.kind !== 'waiting-on-you' || status.gate !== 'merge') return null
    return { stage: 'revise', status: queued(at, 'changes-requested'), pr: pr === null ? null : { ...pr, approvedAt: null } }
  },
  grant: ({ stage, status }) => (stage === 'revise' && status.kind === 'queued' && status.reason === 'changes-requested' ? { stage, status } : null),
  'approve-plan': ({ stage, status }, _move, at) => (stage === 'plan' && status.kind === 'waiting-on-you' && status.gate === 'plan-approval' ? { stage: 'implement', status: queued(at, 'new') } : null),
  'request-plan-changes': ({ stage, status }, _move, at) => (stage === 'plan' && status.kind === 'waiting-on-you' && status.gate === 'plan-approval' ? { stage: 'plan', status: queued(at, 'changes-requested') } : null),
  escalate: ({ stage, status }, { detail }) => (status.kind === 'queued' || status.kind === 'held' || status.kind === 'running' ? { stage, status: { kind: 'waiting-on-you', gate: 'escalation', detail } } : null),
}

export function applyMove(ticket: Ticket, move: OperatorMove, at: string): MoveNext | null {
  const apply = OPERATOR_MOVES[move.kind] as (ticket: Ticket, move: OperatorMove, at: string) => MoveNext | null
  return apply(ticket, move, at)
}
