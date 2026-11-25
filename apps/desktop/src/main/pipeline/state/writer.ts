// The one writer every pipeline transition goes through: the table commit, then the display mirror of both halves of the ticket.
import { displayOf } from '@/main/pipeline/state/display'
import { halvesOf, issueNumberOfBranch, mirrorDiff, mirrorNamesOf } from '@/main/pipeline/state/mirror'
import { stateLabelsOf, UNSEEDED_MESSAGE } from '@/main/pipeline/state/labels'
import { draftOf, refusedWriteIntent } from '@/main/pipeline/incidents/raise'
import type { StateWriteContext } from '@/main/pipeline/context'
import type { IncidentInputs, IncidentIntent } from '@/types/incidents'
import { fetchItemsByNumber } from '@/main/github/tracker/items'
import { applyLabels } from '@/main/github/writes/apply'
import { appendAudit } from '@/main/github/writes/audit'
import { resolveKeys } from '@/main/github/writes/command'
import { evaluate } from '@/main/github/writes/scope'
import { readOwnership } from '@/main/repos/ownership'
import type { OwnershipRead } from '@/types/dispatch'
import type { GitHubRepoRef, ItemsByNumberFetch } from '@/types/github'
import type { MirrorItemParams, TicketRef } from '@/types/pipeline-state'
import type { StateEvent } from '@/types/stage-labels'
import type { EventWriteRequest, LabelAuditEntry, ObservedItem, OwnershipKind, WriteEventParams, WriteOutcome, WriteStateParams } from '@/types/writes'
import { stateMoved } from '@/types/writes'
import { mirrorVocabularyOf, type MirrorVocabulary } from '@/utils/labels/display'
import type { LabelKey, LabelVocabulary } from '@/utils/labels/vocabulary'
import type { Ticket } from '@/utils/pipeline/ticket'
import type { RepoId } from '@/utils/repos'

/** What one `writeEvent` call learned on the way, for the incident it may raise. */
interface WriteFacts {
  head: string | null
  observed: ObservedItem | null
}

interface MirrorContext {
  readonly repo: string
  readonly repoId: RepoId
  readonly vocabulary: LabelVocabulary
  readonly mirror: MirrorVocabulary
  readonly repoRoot: string
  readonly auditDir: string
  readonly writeId?: string
}

function splitRepo(repo: string): GitHubRepoRef {
  const slash = repo.indexOf('/')
  return slash === -1 ? { owner: repo, name: '' } : { owner: repo.slice(0, slash), name: repo.slice(slash + 1) }
}

function observedOf(read: ItemsByNumberFetch, number: number): ObservedItem | null {
  if (!read.ok || read.unavailable.includes(number)) return null
  const item = read.resolved.find((candidate) => candidate.number === number)
  return item === undefined ? null : { labels: item.labels, assignees: item.assignees, readAt: read.fetchedAt }
}

function settled(outcome: WriteOutcome): boolean {
  return outcome.kind === 'applied' || outcome.kind === 'no-op'
}

/** The labels an event plans, for the incident signature of a refused write. */
function plannedOf(request: EventWriteRequest): { readonly add: readonly string[]; readonly remove: readonly string[]; readonly action: string } {
  const { event } = request
  if (event.kind === 'labels') return { add: event.add, remove: event.remove, action: request.action }
  return { add: [event.kind === 'merged' ? 'merge' : event.stage], remove: [], action: request.action }
}

function preconditionOf(request: EventWriteRequest): IncidentInputs {
  const { event } = request
  return event.kind === 'labels' ? { present: event.expect.present, absent: event.expect.absent, assignees: request.assignees } : { expectedRev: request.expectedRev, assignees: request.assignees }
}

function expectedKeysOf(event: StateEvent): { readonly present: readonly LabelKey[]; readonly absent: readonly LabelKey[] } {
  return event.kind === 'labels' ? event.expect : { present: [], absent: [] }
}

async function audit(ctx: StateWriteContext, mc: MirrorContext, target: TicketRef, action: string, ownership: OwnershipKind, precondition: LabelAuditEntry['precondition'], observed: ObservedItem | null, outcome: WriteOutcome): Promise<WriteOutcome> {
  const entry: LabelAuditEntry = { at: ctx.clock.now().toISOString(), repo: mc.repo, repoId: mc.repoId, kind: target.kind, number: target.number, action, ownership, precondition, observed, call: null, commentBytes: null, result: outcome, ...(mc.writeId === undefined ? {} : { writeId: mc.writeId }) }
  await appendAudit(mc.auditDir, entry)
  return outcome
}

function readOwner(ctx: StateWriteContext, mc: MirrorContext): Promise<OwnershipRead> {
  return readOwnership(ctx, { repoRoot: mc.repoRoot, repo: mc.repo })
}

function labelsCall(ctx: StateWriteContext, mc: MirrorContext, ref: TicketRef, action: string, diff: { readonly addNames: readonly string[]; readonly removeNames: readonly string[] }, assignees: { readonly add: readonly string[]; readonly remove: readonly string[] }, observed: ObservedItem): Promise<WriteOutcome> {
  return applyLabels(ctx, {
    repo: mc.repo,
    repoId: mc.repoId,
    kind: ref.kind,
    number: ref.number,
    action,
    addNames: diff.addNames,
    removeNames: diff.removeNames,
    addAssignees: assignees.add,
    removeAssignees: assignees.remove,
    observed,
    repoRoot: mc.repoRoot,
    auditDir: mc.auditDir,
    writeId: mc.writeId,
  })
}

/** One failure is kept per ticket: the first half that did not settle, cleared only when every half did. */
async function recordOutcomes(ctx: StateWriteContext, mc: MirrorContext, ref: TicketRef, outcomes: readonly WriteOutcome[]): Promise<void> {
  const failed = outcomes.find((outcome) => !settled(outcome))
  await ctx.stores.pipelineState.recordMirror(mc.repoId, ref, failed === undefined ? null : { at: ctx.clock.now().toISOString(), outcome: failed })
}

/** Records the call's incident once its outcome is known; a failure here never changes the outcome. */
async function raiseIncident(ctx: StateWriteContext, request: EventWriteRequest, writeId: string, outcome: WriteOutcome, seen: WriteFacts): Promise<void> {
  try {
    let intent: IncidentIntent | null = request.incident ?? null
    if (intent !== null) {
      const observedHead = intent.inputs.observedHead
      const moved = typeof observedHead === 'string' && seen.head !== null && observedHead !== seen.head
      intent = { ...intent, ...(moved ? { bucket: 'stale-snapshot' as const, condition: 'head-moved', decision: { ...intent.decision, intended: intent.bucket } } : {}), inputs: { ...intent.inputs, writeHead: seen.head } }
    } else if (!stateMoved(outcome)) {
      intent = refusedWriteIntent(plannedOf(request), outcome.kind, seen.observed, preconditionOf(request))
    }
    if (intent === null) return
    const tick = typeof intent.inputs.snapshotAt === 'string' ? intent.inputs.snapshotAt : null
    await ctx.stores.incidentLog.record(draftOf(intent, { repo: request.repo, kind: request.kind, number: request.number }, { kind: outcome.kind }, { audit: [writeId], tick }))
  } catch {
    // Best-effort by design: a lost incident costs analysis, a failed write costs the pipeline.
  }
}

/** Writes what the ticket shows onto one half, from a read the caller already holds. */
function mirrorHalf(ctx: StateWriteContext, mc: MirrorContext, ticket: Ticket, half: TicketRef, action: string, observed: ObservedItem, assignees: { readonly add: readonly string[]; readonly remove: readonly string[] }): Promise<WriteOutcome> {
  const names = mirrorNamesOf(displayOf(ticket), mc.mirror.labels, mc.vocabulary)
  return labelsCall(ctx, mc, half, action, mirrorDiff(names.desired, names.all, observed.labels), assignees, observed)
}

/** Never changes the write's own outcome: a failure here is recorded on the ticket and retried by the poll. */
async function mirrorCounterpart(ctx: StateWriteContext, mc: MirrorContext, ticket: Ticket, counterpart: TicketRef, action: string, known: ObservedItem | null): Promise<WriteOutcome[]> {
  const observed = known ?? observedOf(await fetchItemsByNumber(ctx, { repo: splitRepo(mc.repo), numbers: [counterpart.number] }), counterpart.number)
  if (observed === null) return []
  const names = mirrorNamesOf(displayOf(ticket), mc.mirror.labels, mc.vocabulary)
  const diff = mirrorDiff(names.desired, names.all, observed.labels)
  if (diff.addNames.length === 0 && diff.removeNames.length === 0) return []
  return [await labelsCall(ctx, mc, counterpart, action, diff, { add: [], remove: [] }, observed)]
}

async function attemptWrite(ctx: StateWriteContext, params: WriteEventParams, writeId: string, seen: WriteFacts): Promise<WriteOutcome> {
  const { request } = params
  const store = ctx.stores.pipelineState
  await store.ready
  const mc: MirrorContext = { repo: request.repo, repoId: request.repoId, vocabulary: request.vocabulary, mirror: request.mirror, repoRoot: params.repoRoot, auditDir: params.auditDir, writeId }
  const target: TicketRef = { kind: request.kind, number: request.number }
  const expected = expectedKeysOf(request.event)
  const present = resolveKeys(request.vocabulary, expected.present)
  const absent = resolveKeys(request.vocabulary, expected.absent)
  const precondition: LabelAuditEntry['precondition'] = { present: present.names, absent: absent.names, assignees: request.assignees }

  const ownership = await readOwner(ctx, mc)
  if (ownership.kind === 'unreadable') return audit(ctx, mc, target, request.action, 'unreadable', precondition, null, { kind: 'ownership-unreadable', path: ownership.path, message: ownership.message })
  const log = (observed: ObservedItem | null, outcome: WriteOutcome): Promise<WriteOutcome> => {
    seen.observed = observed
    return audit(ctx, mc, target, request.action, ownership.kind, precondition, observed, outcome)
  }

  const { event } = request
  const keysToResolve = event.kind === 'labels' ? [event.add, event.remove] : []
  const unresolved = [...new Set([...present.unresolved, ...absent.unresolved, ...keysToResolve.flatMap((list) => resolveKeys(request.vocabulary, list).unresolved)])]
  if (unresolved.length > 0) return log(null, { kind: 'unresolvable-label', keys: unresolved })

  const stored = store.ticket(request.repoId, target)
  if (store.tickets(request.repoId) === null) return log(null, { kind: 'state-unsaved', message: UNSEEDED_MESSAGE })
  const other = stored === null ? undefined : halvesOf(stored).find((half) => half.number !== request.number)
  const numbers = other === undefined ? [request.number] : [request.number, other.number]

  const read = await fetchItemsByNumber(ctx, { repo: splitRepo(request.repo), numbers })
  if (!read.ok) return log(null, { kind: 'verify-failed', message: read.message })
  const item = read.resolved.find((candidate) => candidate.number === request.number)
  seen.head = item?.headRefOid ?? null
  const githubSide = observedOf(read, request.number)
  if (item === undefined || githubSide === null) return log(null, { kind: 'item-unavailable' })

  const assignees = evaluate({ presentNames: [], absentNames: [], assignees: request.assignees }, githubSide)
  if (!assignees.satisfied) {
    return log(githubSide, { kind: 'precondition-failed', conflict: { kind: 'precondition-failed', expected: assignees.expected, observed: assignees.observed, readAt: read.fetchedAt } })
  }

  const applied: StateEvent = event.kind === 'labels' && request.kind === 'pull-request' ? { ...event, issue: issueNumberOfBranch(item.headRefName) } : event
  const moved = await store.apply(request.repoId, target, applied, request.expectedRev)
  if (!moved.ok) {
    if (moved.reason === 'persist-failed') return log(githubSide, { kind: 'state-unsaved', message: moved.message })
    if (moved.reason === 'unseeded') return log(null, { kind: 'state-unsaved', message: UNSEEDED_MESSAGE })
    const names = stateLabelsOf(store.view(request.repoId), request.kind, request.number, request.vocabulary) ?? []
    const observed: ObservedItem = { labels: names, assignees: item.assignees, readAt: read.fetchedAt }
    const verdict = evaluate({ presentNames: present.names, absentNames: absent.names, assignees: { kind: 'any' } }, observed)
    return log(observed, { kind: 'precondition-failed', conflict: { kind: 'precondition-failed', expected: verdict.satisfied ? [] : verdict.expected, observed: names, readAt: read.fetchedAt } })
  }

  const outcome = await mirrorHalf(ctx, mc, moved.ticket, target, request.action, githubSide, { add: request.addAssignees, remove: request.removeAssignees })
  const counterpart = halvesOf(moved.ticket).find((half) => half.number !== request.number)
  const outcomes = counterpart === undefined ? [outcome] : [outcome, ...(await mirrorCounterpart(ctx, mc, moved.ticket, counterpart, request.action, observedOf(read, counterpart.number)))]
  await recordOutcomes(ctx, mc, target, outcomes)
  return settled(outcome) ? outcome : { kind: 'mirror-failed', mirror: outcome }
}

export async function writeEvent(ctx: StateWriteContext, params: WriteEventParams): Promise<WriteOutcome> {
  const writeId = globalThis.crypto.randomUUID()
  const seen: WriteFacts = { head: null, observed: null }
  const outcome = await attemptWrite(ctx, params, writeId, seen)
  await raiseIncident(ctx, params.request, writeId, outcome, seen)
  return outcome
}

/** An operator path's label request, wrapped in one transitional `labels` event. */
export function writeState(ctx: StateWriteContext, params: WriteStateParams): Promise<WriteOutcome> {
  const { request } = params
  const event: StateEvent = { kind: 'labels', itemKind: request.kind, add: request.add, remove: request.remove, expect: { present: request.expect.present, absent: request.expect.absent }, action: request.action, issue: null }
  return writeEvent(ctx, {
    ...params,
    request: {
      repoId: request.repoId,
      repo: request.repo,
      kind: request.kind,
      number: request.number,
      vocabulary: request.vocabulary,
      mirror: request.mirror,
      event,
      expectedRev: null,
      assignees: request.expect.assignees,
      addAssignees: request.addAssignees,
      removeAssignees: request.removeAssignees,
      action: request.action,
      ...(request.incident === undefined ? {} : { incident: request.incident }),
    },
  })
}

/** Mirrors both halves of the ticket `ref` names, as the store holds it. */
export async function mirrorItem(ctx: StateWriteContext, params: MirrorItemParams): Promise<WriteOutcome> {
  const { entry, ref, action } = params
  const store = ctx.stores.pipelineState
  await store.ready
  const mc: MirrorContext = { repo: entry.config.repo, repoId: entry.id, vocabulary: entry.config.vocabulary, mirror: mirrorVocabularyOf(entry.config), repoRoot: entry.path, auditDir: params.auditDir }
  const ownership = await readOwner(ctx, mc)
  if (ownership.kind === 'unreadable') return audit(ctx, mc, ref, action, 'unreadable', null, null, { kind: 'ownership-unreadable', path: ownership.path, message: ownership.message })

  const ticket = store.ticket(entry.id, ref)
  if (ticket === null) return audit(ctx, mc, ref, action, ownership.kind, null, null, { kind: 'item-unavailable' })

  const outcomes: WriteOutcome[] = []
  for (const half of halvesOf(ticket)) {
    const read = await fetchItemsByNumber(ctx, { repo: splitRepo(mc.repo), numbers: [half.number] })
    const observed = observedOf(read, half.number)
    if (!read.ok || observed === null) {
      const outcome: WriteOutcome = read.ok ? { kind: 'item-unavailable' } : { kind: 'verify-failed', message: read.message }
      outcomes.push(await audit(ctx, mc, half, action, ownership.kind, null, null, outcome))
      continue
    }
    outcomes.push(await mirrorHalf(ctx, mc, ticket, half, action, observed, { add: [], remove: [] }))
  }
  await recordOutcomes(ctx, mc, ref, outcomes)
  return outcomes.find((outcome) => !settled(outcome)) ?? outcomes[0] ?? { kind: 'item-unavailable' }
}
