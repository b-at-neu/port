// Pure: the (ticket, event) → ticket table. No I/O — the store commits what this returns, and only after it is persisted.
import { HISTORY_CAP, ticketOfKeys } from '@/main/pipeline/state/migrate'
import { legacyKeysOf } from '@/main/pipeline/state/mirror'
import { applyRunChange } from '@/main/pipeline/runs'
import type { PipelineItemKind } from '@/types/github'
import type { TicketRef } from '@/types/pipeline-state'
import { stageOfMode, type StageEvent, type StageMode, type StateEvent, type TableResult, type TicketEvent } from '@/types/stage-labels'
import type { StageHandback } from '@/types/stage-session'
import type { HandoffRefusal, StageAgent } from '@/types/tick'
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { Event, Stage, Status, Ticket } from '@/utils/pipeline/ticket'
import type { RepoId } from '@/utils/repos'

/** The closed vocabulary of `HANDBACK:` tokens each mode may end with — pinned both directions against the bundled agents by `desktop-stage-labels`. */
export const HANDBACK_TOKENS: Readonly<Record<StageMode, readonly string[]>> = {
  plan: ['plan-written'],
  impl: ['pr-opened'],
  review: ['approved', 'needs-revision', 'checks-pending', 'rebase-required', 'head-moved'],
  revise: ['revised', 'escalated'],
  refresh: ['refreshed', 'escalated'],
}

// A review hand-back that is a verdict on the head ends one review cycle; the other tokens re-queue the same head.
const NON_VERDICT_TOKENS: readonly string[] = ['rebase-required', 'head-moved']

export function stageModeFor(agent: StageAgent, trigger: LabelKey): StageMode {
  return trigger === 'refreshBranch' ? 'refresh' : agent
}

export function itemKindFor(mode: StageMode): PipelineItemKind {
  return mode === 'plan' || mode === 'impl' ? 'issue' : 'pull-request'
}

/** A pull request number, with or without a leading hash; nothing else. */
export function pullRequestNumberOf(arg: string | null): number | null {
  if (arg === null) return null
  const match = /^#?(\d+)$/.exec(arg)
  if (match === null) return null
  const parsed = Number(match[1])
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

/** The hand-back a completed outcome or an adoption carries, `undefined` for any other event. */
function handbackOf(event: StageEvent): StageHandback | null | undefined {
  if (event.kind === 'adopt') return event.handback
  return event.kind === 'outcome' && event.outcome === 'completed' ? event.handback : undefined
}

/** Why a finished stage's `HANDBACK:` line cannot be acted on — checked before any read, since it never changes. An adopted hand-back's plan is already in the issue body, so it needs no plan file. */
export function handbackRefusal(event: StageEvent, mode: StageMode): HandoffRefusal | null {
  const handback = handbackOf(event)
  if (handback === undefined) return null
  if (handback === null) return 'no-handback'
  if (!HANDBACK_TOKENS[mode].includes(handback.token)) return 'unknown-handback'
  if (mode === 'impl' && pullRequestNumberOf(handback.arg) === null) return 'unknown-handback'
  if (mode === 'refresh' && handback.token === 'refreshed' && handback.arg !== 'clean' && handback.arg !== 'resolved') return 'unknown-handback'
  if (event.kind === 'outcome' && mode === 'plan' && handback.token === 'plan-written') {
    if (event.plan === null || event.plan.kind === 'missing') return 'no-plan-file'
    if (event.plan.kind === 'empty') return 'empty-plan-file'
  }
  return null
}

/** Whether an event writes anything at all — the rest wait for the session to carry on or for Resume/Restart. */
export function eventWrites(event: StageEvent, mode: StageMode): boolean {
  if (event.kind !== 'outcome') return true
  if (event.outcome === 'blocked') return mode === 'impl'
  return event.outcome === 'completed' || event.outcome === 'error'
}

function handbackEvent(stage: Stage, handback: StageHandback, via: 'session' | 'adopt'): StateEvent {
  return { kind: 'handback', stage, token: handback.token, arg: handback.arg, pr: stage === 'implement' ? pullRequestNumberOf(handback.arg) : null, via }
}

/** The table event a stage event stands for; `null` when the stage event writes nothing. */
export function ticketEventOf(event: StageEvent, mode: StageMode): StateEvent | null {
  const stage = stageOfMode(mode)
  switch (event.kind) {
    case 'claim':
    case 'rollback':
      return { kind: event.kind, stage }
    case 'resumed-turn':
      return mode === 'impl' ? { kind: 'resumed-turn', stage: 'implement' } : null
    case 'adopt':
      return handbackEvent(stage, event.handback, 'adopt')
    case 'outcome':
      switch (event.outcome) {
        case 'completed':
          return event.handback === null ? null : handbackEvent(stage, event.handback, 'session')
        case 'blocked':
          return mode === 'impl' ? { kind: 'blocked', stage: 'implement' } : null
        case 'error':
          return { kind: 'error-reset', stage }
        case 'questions':
        case 'interrupted':
        case 'usage-limit':
          return null
      }
  }
}

export interface TableContext {
  readonly at: string
  readonly actor: string | null
  readonly repo: RepoId
  /** The half the event names; a missing ticket is created from it. */
  readonly ref: TicketRef
}

const MOVED: TableResult = { ok: false, reason: 'moved' }
const UNKNOWN: TableResult = { ok: false, reason: 'unknown-handback' }

interface Next {
  readonly stage: Stage
  readonly status: Status
  readonly pr?: Ticket['pr']
}

const queued = (at: string, reason: 'new' | 'changes-requested' | 'retry' = 'new'): Status => ({ kind: 'queued', reason, since: at })
const waiting = (gate: 'plan-approval' | 'merge' | 'escalation'): Status => ({ kind: 'waiting-on-you', gate, detail: '' })

/** The audit verb an event is recorded under. */
export function actionOf(event: StateEvent): string {
  switch (event.kind) {
    case 'claim':
      return 'stage-claim'
    case 'rollback':
      return 'stage-rollback'
    case 'error-reset':
      return 'stage-error-reset'
    case 'blocked':
      return 'stage-blocked'
    case 'resumed-turn':
      return 'stage-unblocked'
    case 'merged':
      return 'mirror-merged'
    case 'labels':
      return event.action
    case 'handback': {
      const prefix = event.via === 'adopt' ? 'stage-adopt' : 'stage-handback'
      return `${prefix}-${event.token}${event.token === 'refreshed' ? `-${event.arg ?? ''}` : ''}`
    }
  }
}

function handbackNext(ticket: Ticket, event: Extract<StateEvent, { kind: 'handback' }>, at: string): Next | TableResult {
  const { pr } = ticket
  const unapproved = pr === null ? null : { ...pr, approvedAt: null }
  switch (`${event.stage}:${event.token}`) {
    case 'plan:plan-written':
      return { stage: 'plan', status: waiting('plan-approval') }
    case 'implement:pr-opened':
      return event.pr === null ? UNKNOWN : { stage: 'review', status: queued(at), pr: { number: event.pr, approvedAt: null } }
    case 'review:approved':
      return { stage: 'merge', status: waiting('merge'), pr: pr === null ? null : { ...pr, approvedAt: at } }
    case 'review:needs-revision':
      return { stage: 'revise', status: queued(at, 'changes-requested') }
    case 'review:checks-pending':
      return { stage: 'review', status: waiting('escalation') }
    case 'review:rebase-required':
      return { stage: 'refresh', status: queued(at) }
    case 'review:head-moved':
    case 'revise:revised':
      return { stage: 'review', status: queued(at) }
    case 'revise:escalated':
      return { stage: 'revise', status: waiting('escalation') }
    case 'refresh:refreshed':
      if (event.arg === 'resolved') return { stage: 'review', status: queued(at), pr: unapproved }
      if (event.arg !== 'clean') return UNKNOWN
      return pr !== null && pr.approvedAt !== null ? { stage: 'merge', status: waiting('merge') } : { stage: 'review', status: queued(at) }
    case 'refresh:escalated':
      return { stage: 'refresh', status: waiting('escalation'), pr: unapproved }
    default:
      return UNKNOWN
  }
}

/** The statuses a hand-back may settle: the session's own `running`, or the `queued retry` a liveness reset left. A `pr-opened` also settles a blocked or freshly queued issue. */
function settles(ticket: Ticket, event: Extract<StateEvent, { kind: 'handback' }>): boolean {
  if (ticket.stage !== event.stage) return false
  const { status } = ticket
  if (status.kind === 'running') return true
  if (event.token === 'pr-opened') return status.kind === 'blocked' || status.kind === 'queued'
  return status.kind === 'queued' && status.reason === 'retry'
}

function stageEventNext(ticket: Ticket, event: Exclude<StateEvent, { kind: 'labels' | 'merged' }>, at: string): Next | TableResult {
  const { status } = ticket
  switch (event.kind) {
    case 'claim':
      return status.kind === 'queued' && ticket.stage === event.stage ? { stage: event.stage, status: { kind: 'running', runId: null } } : MOVED
    case 'rollback':
    case 'error-reset':
      return ticket.stage === event.stage && (status.kind === 'running' || (status.kind === 'blocked' && event.stage === 'implement')) ? { stage: event.stage, status: queued(at, 'retry') } : MOVED
    case 'blocked':
      return status.kind === 'running' && ticket.stage === 'implement' ? { stage: 'implement', status: { kind: 'blocked', on: [], reason: '' } } : MOVED
    case 'resumed-turn':
      return status.kind === 'blocked' && ticket.stage === 'implement' ? { stage: 'implement', status: { kind: 'running', runId: null } } : MOVED
    case 'handback': {
      if (!settles(ticket, event)) return MOVED
      const next = handbackNext(ticket, event, at)
      const alreadyThere = event.token === 'head-moved' && ticket.stage === 'review' && status.kind === 'queued'
      return alreadyThere ? { ticket, changed: false, ok: true } : next
    }
  }
}

const prefixedKeys = (ticket: Ticket): Set<string> => {
  const halves = (['issue', 'pull-request'] as const).flatMap((kind) => (legacyKeysOf(ticket, kind) ?? []).map((key) => `${kind}:${key}`))
  return new Set(halves)
}

function isVerdict(event: StateEvent): boolean {
  return event.kind === 'handback' && event.via === 'session' && event.stage === 'review' && HANDBACK_TOKENS.review.includes(event.token) && !NON_VERDICT_TOKENS.includes(event.token)
}

/** Records one change on the ticket: its `rev`, its history row with the label diff of both halves, and a review verdict's cycle. A `null` ticket is a creation. */
function commit(ticket: Ticket | null, next: Ticket, event: StateEvent, ctx: TableContext): TableResult {
  const before = ticket === null ? new Set<string>() : prefixedKeys(ticket)
  const after = prefixedKeys(next)
  const add = [...after].filter((key) => !before.has(key))
  const remove = [...before].filter((key) => !after.has(key))
  const row: Event = { at: ctx.at, action: actionOf(event), actor: ctx.actor, to: { stage: next.stage, status: next.status.kind }, legacy: add.length === 0 && remove.length === 0 ? null : { add, remove } }
  return {
    ok: true,
    changed: true,
    ticket: { ...next, rev: (ticket?.rev ?? -1) + 1, reviewCycles: (ticket?.reviewCycles ?? 0) + (isVerdict(event) ? 1 : 0), history: [...(ticket?.history ?? []), row].slice(-HISTORY_CAP) },
  }
}

function applyLabels(ticket: Ticket | null, event: Extract<StateEvent, { kind: 'labels' }>, ctx: TableContext): TableResult {
  const { itemKind } = event
  const current = ticket === null ? [] : (legacyKeysOf(ticket, itemKind) ?? [])
  if (!event.expect.present.every((key) => current.includes(key)) || event.expect.absent.some((key) => current.includes(key))) return MOVED
  const keys: LabelKey[] = current.filter((key) => !event.remove.includes(key))
  for (const key of event.add) if (!keys.includes(key)) keys.push(key)

  const otherKind = itemKind === 'issue' ? 'pull-request' : 'issue'
  const other = ticket === null ? null : legacyKeysOf(ticket, otherKind)
  const issueKeys = itemKind === 'issue' ? keys : (other ?? [])
  const prNumber = itemKind === 'pull-request' ? ctx.ref.number : (ticket?.pr?.number ?? null)
  const prKeys = itemKind === 'pull-request' ? keys : other
  const resolved = ticketOfKeys({
    repo: ctx.repo,
    ticket: ticket?.ticket ?? (itemKind === 'issue' ? ctx.ref.number : (event.issue ?? ctx.ref.number)),
    issueKeys,
    pr: prNumber === null ? null : { number: prNumber, keys: prKeys ?? [], approvedAt: ticket?.pr?.number === prNumber ? ticket.pr.approvedAt : null },
    history: ticket?.history ?? [],
    at: ctx.at,
    mirrorFailure: ticket?.mirror.failure ?? null,
    reviewCycles: ticket?.reviewCycles ?? 0,
    stageHint: ticket?.stage ?? null,
  }).ticket
  const next: Ticket = ticket === null ? resolved : { ...ticket, stage: resolved.stage, status: resolved.status, pr: resolved.pr, autoPlan: resolved.autoPlan }
  if (ticket === null) return commit(null, next, event, ctx)
  const unchanged = [...prefixedKeys(ticket)].sort().join() === [...prefixedKeys(next)].sort().join()
  return unchanged ? { ok: true, ticket, changed: false } : commit(ticket, next, event, ctx)
}

/** Whether the table would take the event from where the ticket stands now; nothing is committed. */
export function accepts(ticket: Ticket | null, event: TicketEvent, ref: TicketRef, repo: RepoId): boolean {
  return applyEvent(ticket, event, { at: '1970-01-01T00:00:00.000Z', actor: null, repo, ref }).ok
}

/** What the table makes of one event: the next ticket, or a refusal when the ticket is not where the event expects it. A missing ticket exists only for a `labels` event, which creates it. */
export function applyEvent(ticket: Ticket | null, event: TicketEvent, ctx: TableContext): TableResult {
  if (event.kind === 'labels') return applyLabels(ticket, event, ctx)
  if (ticket === null) return MOVED
  if (event.kind === 'run-start' || event.kind === 'run') return applyRunChange(ticket, event, ctx.at)
  if (event.kind === 'merged') {
    return ticket.status.kind === 'done' ? { ok: true, ticket, changed: false } : commit(ticket, { ...ticket, stage: 'merge', status: { kind: 'done', at: ctx.at } }, event, ctx)
  }
  const next = stageEventNext(ticket, event, ctx.at)
  if ('ok' in next) return next
  return commit(ticket, { ...ticket, stage: next.stage, status: next.status, pr: next.pr === undefined ? ticket.pr : next.pr }, event, ctx)
}
