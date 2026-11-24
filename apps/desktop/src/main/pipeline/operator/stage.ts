// Every state write a stage session needs — claim, rollback, hand-back, next turn — as one typed ticket event through `writeEvent` and nowhere else.
import { accepts, actionOf, handbackRefusal, pullRequestNumberOf, stageModeFor, ticketEventOf } from '@/main/pipeline/transitions'
import type { ReadyEntry } from '@/types/actions'
import type { FetchItemsByNumberParams, ItemsByNumberFetch, PipelineItemKind, ResolvedItem } from '@/types/github'
import type { StageEvent, StageTransitionResult, TicketEvent } from '@/types/stage-labels'
import type { HandoffRefusal, TickActionable } from '@/types/tick'
import { stageHandbackIntent } from '@/main/pipeline/incidents/raise'
import type { StageSnapshot } from '@/types/dispatch'
import type { IncidentIntent } from '@/types/incidents'
import type { EventWriteRequest, PostCommentParams, WriteEvent, WriteOutcome } from '@/types/writes'
import { stateMoved } from '@/types/writes'
import { mirrorVocabularyOf } from '@/utils/labels/display'
import type { Ticket } from '@/utils/pipeline/ticket'
import type { RepoId } from '@/utils/repos'

export interface StageWriteDeps {
  readonly writeEvent: WriteEvent
  /** The ticket a half belongs to, `null` when the repository is unseeded or the half is untracked. */
  readonly ticketOf: (repoId: RepoId, kind: PipelineItemKind, number: number) => Ticket | null
  readonly postIssueBody: (params: PostCommentParams) => Promise<WriteOutcome>
  readonly fetchItemsByNumber: (params: FetchItemsByNumberParams) => Promise<ItemsByNumberFetch>
}

type StageSubject = Pick<TickActionable, 'number' | 'kind' | 'agent' | 'trigger'>

interface ApplyStageClaimParams {
  readonly entry: ReadyEntry
  readonly candidate: StageSubject
  /** The dispatcher's own pre-launch re-read of this item. */
  readonly resolved: ResolvedItem
  readonly auditDir: string
}

interface ApplyStageTransitionParams {
  readonly entry: ReadyEntry
  readonly record: StageSubject
  readonly event: StageEvent
  readonly auditDir: string
  /** Where a posted plan body's scratch `--body-file` is written. */
  readonly scratchDir: string
  /** The tick's view of the ticket, for the incident a `blocked` or `needsHuman` hand-back raises. */
  readonly snapshot?: StageSnapshot
}

function refused(reason: HandoffRefusal, retryable: boolean, detail: string | null = null): StageTransitionResult {
  return { kind: 'refused', reason, retryable, detail }
}

/** A `WriteOutcome` that is not `applied`/`no-op`, as the one refusal a hand-back reports; the four transient kinds are the only retryable ones. */
function refusalOf(outcome: WriteOutcome): StageTransitionResult {
  switch (outcome.kind) {
    case 'precondition-failed':
      return refused('moved', false)
    case 'unresolvable-label':
      return refused('unresolvable-label', false, outcome.keys.join(', '))
    case 'write-failed':
      return refused('write-failed', true, outcome.stderr)
    case 'verify-failed':
      return refused('write-failed', true, outcome.message)
    case 'state-unsaved':
      return refused('write-failed', true, outcome.message)
    case 'ownership-unreadable':
      return refused('write-failed', true, outcome.message)
    case 'item-unavailable':
      return refused('write-failed', true, 'the item could not be read')
    case 'applied':
    case 'no-op':
    case 'mirror-failed':
      return { kind: 'applied' }
  }
}

/** The label an event that lands on a human leaves the ticket under, for the incident it raises. */
function landedOn(event: TicketEvent): 'blocked' | 'needsHuman' | null {
  if (event.kind === 'blocked') return 'blocked'
  return event.kind === 'handback' && (event.token === 'checks-pending' || event.token === 'escalated') ? 'needsHuman' : null
}

function requestFor(entry: ReadyEntry, subject: StageSubject, event: TicketEvent, ticket: Ticket | null, resolved: ResolvedItem, incident: IncidentIntent | null): EventWriteRequest {
  return {
    ...(incident === null ? {} : { incident }),
    repoId: entry.id,
    repo: entry.config.repo,
    kind: subject.kind,
    number: subject.number,
    vocabulary: entry.config.vocabulary,
    mirror: mirrorVocabularyOf(entry.config),
    event,
    expectedRev: ticket?.rev ?? null,
    assignees: { kind: 'exactly', logins: resolved.assignees },
    addAssignees: [],
    removeAssignees: [],
    action: actionOf(event),
  }
}

/** Trigger → in-flight, from the dispatcher's own re-read so the claim never makes a second read. */
export async function applyStageClaim(params: ApplyStageClaimParams, deps: StageWriteDeps): Promise<StageTransitionResult> {
  const { entry, candidate, resolved } = params
  const event = ticketEventOf({ kind: 'claim' }, stageModeFor(candidate.agent, candidate.trigger))
  if (event === null) return { kind: 'applied' }
  const ticket = deps.ticketOf(entry.id, candidate.kind, candidate.number)
  const outcome = await deps.writeEvent({ request: requestFor(entry, candidate, event, ticket, resolved, null), repoRoot: entry.path, auditDir: params.auditDir })
  return stateMoved(outcome) ? { kind: 'applied' } : refusalOf(outcome)
}

function isOpenPullRequestOn(resolved: ResolvedItem | undefined, issueNumber: number): resolved is ResolvedItem {
  return resolved !== undefined && resolved.kind === 'pull-request' && resolved.state === 'OPEN' && (resolved.headRefName ?? '').startsWith(`${String(issueNumber)}-`)
}

/** Rollback, hand-back and next-turn writes: a fresh read first, then the table. A `pr-opened` hand-back is verified against the pull request it names before anything is written. */
export async function applyStageTransition(params: ApplyStageTransitionParams, deps: StageWriteDeps): Promise<StageTransitionResult> {
  const { entry, record, event } = params
  const mode = stageModeFor(record.agent, record.trigger)
  const unusable = handbackRefusal(event, mode)
  if (unusable !== null) return refused(unusable, false, event.kind === 'outcome' && event.plan?.kind === 'missing' ? event.plan.detail : null)
  const handback = event.kind === 'outcome' || event.kind === 'adopt' ? event.handback : null
  const prNumber = mode === 'impl' && handback?.token === 'pr-opened' ? pullRequestNumberOf(handback.arg) : null

  const numbers = prNumber === null ? [record.number] : [record.number, prNumber]
  const fetched = await deps.fetchItemsByNumber({ repo: { owner: entry.config.owner, name: entry.config.name }, numbers })
  if (!fetched.ok) return refused('write-failed', true, fetched.message)
  const itemsByNumber = new Map(fetched.resolved.filter((r) => !fetched.unavailable.includes(r.number)).map((r) => [r.number, r] as const))
  const resolved = itemsByNumber.get(record.number)
  if (resolved === undefined) return refused('write-failed', true, 'the item could not be read')

  if (prNumber !== null && !isOpenPullRequestOn(itemsByNumber.get(prNumber), record.number)) return refused('pr-unverified', false)

  const ticketEvent = ticketEventOf(event, mode)
  if (ticketEvent === null) return { kind: 'applied' }
  const ticket = deps.ticketOf(entry.id, record.kind, record.number)
  if (ticket !== null && event.kind === 'outcome' && event.plan?.kind === 'read' && accepts(ticket, ticketEvent, { kind: record.kind, number: record.number }, entry.id)) {
    const posted = await deps.postIssueBody({
      request: { repoId: entry.id, repo: entry.config.repo, kind: 'issue', number: record.number, body: event.plan.body, action: 'stage-handback-plan-body', scratchDir: params.scratchDir },
      repoRoot: entry.path,
      auditDir: params.auditDir,
    })
    if (!stateMoved(posted)) return refusalOf(posted)
  }

  const landed = landedOn(ticketEvent)
  const incident = params.snapshot === undefined || landed === null ? null : stageHandbackIntent({ key: landed, action: actionOf(ticketEvent) }, record.agent, record.number, params.snapshot.item, params.snapshot.at)
  const outcome = await deps.writeEvent({ request: requestFor(entry, record, ticketEvent, ticket, resolved, incident), repoRoot: entry.path, auditDir: params.auditDir })
  return stateMoved(outcome) ? { kind: 'applied' } : refusalOf(outcome)
}
