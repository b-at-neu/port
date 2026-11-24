// The one writer every pipeline transition goes through: the table commit, then the display mirror of both halves of the ticket.
import { displayOf } from '@/main/pipeline/state/display'
import { halvesOf, issueNumberOfBranch, mirrorDiff, mirrorNamesOf } from '@/main/pipeline/state/mirror'
import { stateLabelsOf, UNSEEDED_MESSAGE } from '@/main/pipeline/state/labels'
import { draftOf, refusedWriteIntent } from '@/main/pipeline/incidents/raise'
import type { IncidentInputs, IncidentIntent, RecordIncident } from '@/types/incidents'
import { resolveKeys } from '@/main/github/writes/command'
import { evaluate } from '@/main/github/writes/scope'
import type { OwnershipParams, OwnershipRead } from '@/types/dispatch'
import type { FetchItemsByNumberParams, GitHubRepoRef, ItemsByNumberFetch } from '@/types/github'
import type { MirrorItemParams, PipelineStateStore, TicketRef } from '@/types/pipeline-state'
import type { TicketEvent } from '@/types/stage-labels'
import type { ApplyLabelsParams, AuditEntry, EventWriteRequest, LabelAuditEntry, ObservedItem, OwnershipKind, WriteEventParams, WriteOutcome, WriteStateParams } from '@/types/writes'
import { stateMoved } from '@/types/writes'
import { mirrorVocabularyOf, type MirrorVocabulary } from '@/utils/labels/display'
import type { LabelKey, LabelVocabulary } from '@/utils/labels/vocabulary'
import type { Ticket } from '@/utils/pipeline/ticket'
import type { RepoId } from '@/utils/repos'

interface StateWriterDeps {
  readonly store: PipelineStateStore
  readonly applyLabels: (params: ApplyLabelsParams) => Promise<WriteOutcome>
  readonly readOwnership: (params: OwnershipParams) => Promise<OwnershipRead>
  readonly fetchItemsByNumber: (params: FetchItemsByNumberParams) => Promise<ItemsByNumberFetch>
  readonly appendAudit: (auditDir: string, entry: AuditEntry) => Promise<unknown>
  readonly recordIncident: RecordIncident
  readonly newId: () => string
  readonly now: () => Date
}

/** What one `writeEvent` call learned on the way, for the incident it may raise. */
interface WriteFacts {
  head: string | null
  observed: ObservedItem | null
}

interface StateWriter {
  readonly writeState: (params: WriteStateParams) => Promise<WriteOutcome>
  readonly writeEvent: (params: WriteEventParams) => Promise<WriteOutcome>
  readonly mirrorItem: (params: MirrorItemParams) => Promise<WriteOutcome>
}

interface MirrorContext {
  readonly repo: string
  readonly repoId: RepoId
  readonly vocabulary: LabelVocabulary
  readonly mirror: MirrorVocabulary
  readonly repoRoot: string
  readonly auditDir: string
  readonly gh?: WriteStateParams['gh']
  readonly git?: WriteStateParams['git']
  readonly pathOps?: WriteStateParams['pathOps']
  readonly fetchItemsByNumber?: WriteStateParams['fetchItemsByNumber']
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

function expectedKeysOf(event: TicketEvent): { readonly present: readonly LabelKey[]; readonly absent: readonly LabelKey[] } {
  return event.kind === 'labels' ? event.expect : { present: [], absent: [] }
}

export function createStateWriter(deps: StateWriterDeps): StateWriter {
  async function audit(ctx: MirrorContext, target: TicketRef, action: string, ownership: OwnershipKind, precondition: LabelAuditEntry['precondition'], observed: ObservedItem | null, outcome: WriteOutcome): Promise<WriteOutcome> {
    const entry: LabelAuditEntry = { at: deps.now().toISOString(), repo: ctx.repo, repoId: ctx.repoId, kind: target.kind, number: target.number, action, ownership, precondition, observed, call: null, commentBytes: null, result: outcome, ...(ctx.writeId === undefined ? {} : { writeId: ctx.writeId }) }
    await deps.appendAudit(ctx.auditDir, entry)
    return outcome
  }

  function readOwner(ctx: MirrorContext): Promise<OwnershipRead> {
    return deps.readOwnership({ repoRoot: ctx.repoRoot, repo: ctx.repo })
  }

  function labelsCall(ctx: MirrorContext, ref: TicketRef, action: string, diff: { readonly addNames: readonly string[]; readonly removeNames: readonly string[] }, assignees: { readonly add: readonly string[]; readonly remove: readonly string[] }, observed: ObservedItem): Promise<WriteOutcome> {
    return deps.applyLabels({
      repo: ctx.repo,
      repoId: ctx.repoId,
      kind: ref.kind,
      number: ref.number,
      action,
      addNames: diff.addNames,
      removeNames: diff.removeNames,
      addAssignees: assignees.add,
      removeAssignees: assignees.remove,
      observed,
      repoRoot: ctx.repoRoot,
      auditDir: ctx.auditDir,
      writeId: ctx.writeId,
      gh: ctx.gh,
      git: ctx.git,
      fetchItemsByNumber: ctx.fetchItemsByNumber,
      pathOps: ctx.pathOps,
      now: deps.now,
    })
  }

  /** One failure is kept per ticket: the first half that did not settle, cleared only when every half did. */
  async function recordOutcomes(ctx: MirrorContext, ref: TicketRef, outcomes: readonly WriteOutcome[]): Promise<void> {
    const failed = outcomes.find((outcome) => !settled(outcome))
    await deps.store.recordMirror(ctx.repoId, ref, failed === undefined ? null : { at: deps.now().toISOString(), outcome: failed })
  }

  /** Records the call's incident once its outcome is known; a failure here never changes the outcome. */
  async function raiseIncident(request: EventWriteRequest, writeId: string, outcome: WriteOutcome, seen: WriteFacts): Promise<void> {
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
      await deps.recordIncident(draftOf(intent, { repo: request.repo, kind: request.kind, number: request.number }, { kind: outcome.kind }, { audit: [writeId], tick }))
    } catch {
      // Best-effort by design: a lost incident costs analysis, a failed write costs the pipeline.
    }
  }

  /** An operator path's label request, wrapped in one transitional `labels` event. */
  function writeState(params: WriteStateParams): Promise<WriteOutcome> {
    const { request } = params
    const event: TicketEvent = { kind: 'labels', itemKind: request.kind, add: request.add, remove: request.remove, expect: { present: request.expect.present, absent: request.expect.absent }, action: request.action, issue: null }
    return writeEvent({
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

  async function writeEvent(params: WriteEventParams): Promise<WriteOutcome> {
    const writeId = deps.newId()
    const seen: WriteFacts = { head: null, observed: null }
    const outcome = await attemptWrite(params, writeId, seen)
    await raiseIncident(params.request, writeId, outcome, seen)
    return outcome
  }

  async function attemptWrite(params: WriteEventParams, writeId: string, seen: WriteFacts): Promise<WriteOutcome> {
    const { request } = params
    await deps.store.ready
    const ctx: MirrorContext = { repo: request.repo, repoId: request.repoId, vocabulary: request.vocabulary, mirror: request.mirror, repoRoot: params.repoRoot, auditDir: params.auditDir, gh: params.gh, git: params.git, pathOps: params.pathOps, fetchItemsByNumber: params.fetchItemsByNumber, writeId }
    const target: TicketRef = { kind: request.kind, number: request.number }
    const expected = expectedKeysOf(request.event)
    const present = resolveKeys(request.vocabulary, expected.present)
    const absent = resolveKeys(request.vocabulary, expected.absent)
    const precondition: LabelAuditEntry['precondition'] = { present: present.names, absent: absent.names, assignees: request.assignees }

    const ownership = await readOwner(ctx)
    if (ownership.kind === 'unreadable') return audit(ctx, target, request.action, 'unreadable', precondition, null, { kind: 'ownership-unreadable', path: ownership.path, message: ownership.message })
    const log = (observed: ObservedItem | null, outcome: WriteOutcome): Promise<WriteOutcome> => {
      seen.observed = observed
      return audit(ctx, target, request.action, ownership.kind, precondition, observed, outcome)
    }

    const { event } = request
    const keysToResolve = event.kind === 'labels' ? [event.add, event.remove] : []
    const unresolved = [...new Set([...present.unresolved, ...absent.unresolved, ...keysToResolve.flatMap((list) => resolveKeys(request.vocabulary, list).unresolved)])]
    if (unresolved.length > 0) return log(null, { kind: 'unresolvable-label', keys: unresolved })

    const stored = deps.store.ticket(request.repoId, target)
    if (deps.store.tickets(request.repoId) === null) return log(null, { kind: 'state-unsaved', message: UNSEEDED_MESSAGE })
    const other = stored === null ? undefined : halvesOf(stored).find((half) => half.number !== request.number)
    const numbers = other === undefined ? [request.number] : [request.number, other.number]

    const read = await (params.fetchItemsByNumber ?? deps.fetchItemsByNumber)({ repo: splitRepo(request.repo), numbers })
    if (!read.ok) return log(null, { kind: 'verify-failed', message: read.message })
    const item = read.resolved.find((candidate) => candidate.number === request.number)
    seen.head = item?.headRefOid ?? null
    const githubSide = observedOf(read, request.number)
    if (item === undefined || githubSide === null) return log(null, { kind: 'item-unavailable' })

    const assignees = evaluate({ presentNames: [], absentNames: [], assignees: request.assignees }, githubSide)
    if (!assignees.satisfied) {
      return log(githubSide, { kind: 'precondition-failed', conflict: { kind: 'precondition-failed', expected: assignees.expected, observed: assignees.observed, readAt: read.fetchedAt } })
    }

    const applied: TicketEvent = event.kind === 'labels' && request.kind === 'pull-request' ? { ...event, issue: issueNumberOfBranch(item.headRefName) } : event
    const moved = await deps.store.apply(request.repoId, target, applied, request.expectedRev)
    if (!moved.ok) {
      if (moved.reason === 'persist-failed') return log(githubSide, { kind: 'state-unsaved', message: moved.message })
      if (moved.reason === 'unseeded') return log(null, { kind: 'state-unsaved', message: UNSEEDED_MESSAGE })
      const names = stateLabelsOf(deps.store.view(request.repoId), request.kind, request.number, request.vocabulary) ?? []
      const observed: ObservedItem = { labels: names, assignees: item.assignees, readAt: read.fetchedAt }
      const verdict = evaluate({ presentNames: present.names, absentNames: absent.names, assignees: { kind: 'any' } }, observed)
      return log(observed, { kind: 'precondition-failed', conflict: { kind: 'precondition-failed', expected: verdict.satisfied ? [] : verdict.expected, observed: names, readAt: read.fetchedAt } })
    }

    const outcome = await mirrorHalf(ctx, moved.ticket, target, request.action, githubSide, { add: request.addAssignees, remove: request.removeAssignees })
    const counterpart = halvesOf(moved.ticket).find((half) => half.number !== request.number)
    const outcomes = counterpart === undefined ? [outcome] : [outcome, ...(await mirrorCounterpart(ctx, moved.ticket, counterpart, request.action, observedOf(read, counterpart.number)))]
    await recordOutcomes(ctx, target, outcomes)
    return settled(outcome) ? outcome : { kind: 'mirror-failed', mirror: outcome }
  }

  /** Writes what the ticket shows onto one half, from a read the caller already holds. */
  function mirrorHalf(ctx: MirrorContext, ticket: Ticket, half: TicketRef, action: string, observed: ObservedItem, assignees: { readonly add: readonly string[]; readonly remove: readonly string[] }): Promise<WriteOutcome> {
    const names = mirrorNamesOf(displayOf(ticket), ctx.mirror.labels, ctx.vocabulary)
    return labelsCall(ctx, half, action, mirrorDiff(names.desired, names.all, observed.labels), assignees, observed)
  }

  /** Never changes the write's own outcome: a failure here is recorded on the ticket and retried by the poll. */
  async function mirrorCounterpart(ctx: MirrorContext, ticket: Ticket, counterpart: TicketRef, action: string, known: ObservedItem | null): Promise<WriteOutcome[]> {
    const observed = known ?? observedOf(await (ctx.fetchItemsByNumber ?? deps.fetchItemsByNumber)({ repo: splitRepo(ctx.repo), numbers: [counterpart.number] }), counterpart.number)
    if (observed === null) return []
    const names = mirrorNamesOf(displayOf(ticket), ctx.mirror.labels, ctx.vocabulary)
    const diff = mirrorDiff(names.desired, names.all, observed.labels)
    if (diff.addNames.length === 0 && diff.removeNames.length === 0) return []
    return [await labelsCall(ctx, counterpart, action, diff, { add: [], remove: [] }, observed)]
  }

  /** Mirrors both halves of the ticket `ref` names, as the store holds it. */
  async function mirrorItem(params: MirrorItemParams): Promise<WriteOutcome> {
    const { entry, ref, action } = params
    await deps.store.ready
    const ctx: MirrorContext = { repo: entry.config.repo, repoId: entry.id, vocabulary: entry.config.vocabulary, mirror: mirrorVocabularyOf(entry.config), repoRoot: entry.path, auditDir: params.auditDir }
    const ownership = await readOwner(ctx)
    if (ownership.kind === 'unreadable') return audit(ctx, ref, action, 'unreadable', null, null, { kind: 'ownership-unreadable', path: ownership.path, message: ownership.message })

    const ticket = deps.store.ticket(entry.id, ref)
    if (ticket === null) return audit(ctx, ref, action, ownership.kind, null, null, { kind: 'item-unavailable' })

    const outcomes: WriteOutcome[] = []
    for (const half of halvesOf(ticket)) {
      const read = await deps.fetchItemsByNumber({ repo: splitRepo(ctx.repo), numbers: [half.number] })
      const observed = observedOf(read, half.number)
      if (!read.ok || observed === null) {
        const outcome: WriteOutcome = read.ok ? { kind: 'item-unavailable' } : { kind: 'verify-failed', message: read.message }
        outcomes.push(await audit(ctx, half, action, ownership.kind, null, null, outcome))
        continue
      }
      outcomes.push(await mirrorHalf(ctx, ticket, half, action, observed, { add: [], remove: [] }))
    }
    await recordOutcomes(ctx, ref, outcomes)
    return outcomes.find((outcome) => !settled(outcome)) ?? outcomes[0] ?? { kind: 'item-unavailable' }
  }

  return { writeState, writeEvent, mirrorItem }
}
