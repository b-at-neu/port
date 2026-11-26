import { mirrorVocabularyOf } from '@/utils/labels/display'
import type { StateWriteContext } from '@/main/pipeline/context'
import { writeEvent, writeState } from '@/main/pipeline/state/writer'
import { actionsFor } from '@/utils/actions/plan'
import type { ItemActionResult, OperatorMove } from '@/types/actions'
import { stageNameOf, ticketViewOf } from '@/utils/pipeline/stages'
import type { TicketView } from '@/utils/pipeline/stages'
import type { Ticket } from '@/utils/pipeline/ticket'
import type { RepoId } from '@/utils/repos'
import type { BoardSnapshot } from '@/types/board'
import type { IncidentIntent } from '@/types/incidents'
import type { ReconciledItem, RepositoryState } from '@/types/state'
import type { AssigneeExpectation, WriteOutcome } from '@/types/writes'
import type { ApplyItemActionParams, ItemActionRequest, ReadyEntry } from '@/types/actions'

export function findRepoState(snapshot: BoardSnapshot, repoId: RepoId): Extract<RepositoryState, { readonly ok: true }> | null {
  const state = snapshot.state.repositories.find((repository) => repository.repoId === repoId)
  return state !== undefined && state.ok ? state : null
}

function findItem(repoState: Extract<RepositoryState, { readonly ok: true }>, kind: ItemActionRequest['kind'], number: number): ReconciledItem | null {
  return repoState.items.find((item) => item.kind === kind && item.number === number) ?? null
}

/** The ticket as the store holds it right now, which a snapshot may already trail. */
export function liveTicketOf(ctx: StateWriteContext, repoId: RepoId, kind: ItemActionRequest['kind'], number: number): Ticket | null {
  return ctx.stores.pipelineState.ticket(repoId, { kind, number })
}

/** Whether a request's view still names where the ticket stands: stage, status kind, and the reason or gate that tells two statuses of one kind apart. */
export function viewMatches(expected: TicketView | null, ticket: Ticket | null): boolean {
  if (expected === null || ticket === null) return expected === null && ticket === null
  const observed = ticketViewOf(ticket)
  if (expected.stage !== observed.stage || expected.status.kind !== observed.status.kind) return false
  if (expected.status.kind === 'queued' && observed.status.kind === 'queued') return expected.status.reason === observed.status.reason
  if (expected.status.kind === 'waiting-on-you' && observed.status.kind === 'waiting-on-you') return expected.status.gate === observed.status.gate
  return true
}

export function movedResult(expected: TicketView | null, observed: TicketView | null | 'gone'): { readonly ok: false; readonly reason: 'moved'; readonly expected: string; readonly observed: string } {
  return {
    ok: false,
    reason: 'moved',
    expected: expected === null ? 'no stage' : stageNameOf(expected),
    observed: observed === 'gone' ? 'no longer tracked' : observed === null ? 'no stage' : stageNameOf(observed),
  }
}

/** Called only after ownership has passed, so `item.assignees` is always `[]` or exactly `[viewer]`. */
function assigneesOf(item: Pick<ReconciledItem, 'assignees'>, viewer: string): AssigneeExpectation {
  return item.assignees.length === 0 ? { kind: 'unassigned' } : { kind: 'exactly', logins: [viewer] }
}

export interface MoveWrite {
  readonly entry: ReadyEntry
  readonly kind: ItemActionRequest['kind']
  readonly number: number
  readonly ticket: Ticket
  readonly move: OperatorMove
  readonly actor: string | null
  readonly assignees: AssigneeExpectation
  readonly addAssignees: readonly string[]
  readonly auditDir: string
  /** The audit action when it is not the move's own name. */
  readonly action?: string
  readonly incident?: IncidentIntent
}

/** One operator move through the writer: the table commit under the ticket's `rev`, then the display mirror. */
export function writeMove(ctx: StateWriteContext, p: MoveWrite): Promise<WriteOutcome> {
  return writeEvent(ctx, {
    request: {
      ...(p.incident === undefined ? {} : { incident: p.incident }),
      repoId: p.entry.id,
      repo: p.entry.config.repo,
      kind: p.kind,
      number: p.number,
      vocabulary: p.entry.config.vocabulary,
      mirror: mirrorVocabularyOf(p.entry.config),
      event: { kind: 'operator', move: p.move, actor: p.actor },
      expectedRev: p.ticket.rev,
      assignees: p.assignees,
      addAssignees: p.addAssignees,
      removeAssignees: [],
      action: p.action ?? p.move.kind,
    },
    repoRoot: p.entry.path,
    auditDir: p.auditDir,
  })
}

/** The one operator write that stays a label write: the marker that gates an untracked pull request. */
function writeGate(ctx: StateWriteContext, entry: ReadyEntry, request: ItemActionRequest, auditDir: string): Promise<WriteOutcome> {
  return writeState(ctx, {
    request: {
      repoId: entry.id,
      repo: entry.config.repo,
      kind: request.kind,
      number: request.number,
      vocabulary: entry.config.vocabulary,
      mirror: mirrorVocabularyOf(entry.config),
      add: ['marker'],
      remove: [],
      addAssignees: [],
      removeAssignees: [],
      expect: { present: [], absent: ['marker'], assignees: { kind: 'any' } },
      action: 'gate',
    },
    repoRoot: entry.path,
    auditDir,
  })
}

export async function applyItemAction(ctx: StateWriteContext, params: ApplyItemActionParams): Promise<ItemActionResult> {
  const { request, snapshot, entry, auditDir } = params
  const repoState = findRepoState(snapshot, entry.id)
  if (repoState === null) return { ok: false, reason: 'repo-unavailable' }

  const item = findItem(repoState, request.kind, request.number)
  if (item === null) return movedResult(request.expected, 'gone')

  const ticket = liveTicketOf(ctx, entry.id, request.kind, request.number)
  if (!viewMatches(request.expected, ticket)) return movedResult(request.expected, ticket === null ? null : ticketViewOf(ticket))

  const view = ticket === null ? null : ticketViewOf(ticket)
  const availability = actionsFor({ view, item: { ...item, ticket }, viewer: repoState.viewer, approvalGate: repoState.approvalGate })[request.action]
  if (!availability.available) {
    if (availability.reason === 'viewer-unknown') return { ok: false, reason: 'viewer-unknown' }
    if (availability.reason === 'not-owned') return { ok: false, reason: 'not-owned', owners: item.assignees }
    // 'not-applicable' here means a client bug, not a real race — stage drift was ruled out above.
    throw new Error(`'${request.action}' is not applicable to ${request.kind} #${String(request.number)}`)
  }

  const { move, addAssignees } = availability.plan
  if (move === null) return { ok: true, outcome: await writeGate(ctx, entry, request, auditDir) }
  if (ticket === null || repoState.viewer === null) throw new Error(`'${request.action}' needs a tracked ticket for ${request.kind} #${String(request.number)}`)

  const outcome = await writeMove(ctx, { entry, kind: request.kind, number: request.number, ticket, move, actor: repoState.viewer, assignees: assigneesOf(item, repoState.viewer), addAssignees, auditDir })
  return { ok: true, outcome }
}
