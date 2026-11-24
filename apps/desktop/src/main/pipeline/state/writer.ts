// The one writer every pipeline transition goes through: the store commit, then the whole-state label mirror.
import {
  allDisplayNames,
  allLegacyNames,
  displayKeysOf,
  displayNamesOf,
  issueNumberOfBranch,
  legacyKeysOf,
  legacyNamesOf,
  linkedIssueOf,
  linkedPullRequestOf,
  mergedDisplayKeys,
  mergedKeysOf,
  mirrorDiff,
} from '@/main/pipeline/state/mirror'
import { stateLabelsOf, UNSEEDED_MESSAGE } from '@/main/pipeline/state/labels'
import { draftOf, refusedWriteIntent } from '@/main/pipeline/incidents/raise'
import type { IncidentIntent, RecordIncident } from '@/types/incidents'
import { resolveKeys } from '@/main/github/writes/command'
import { evaluate } from '@/main/github/writes/scope'
import type { OwnershipParams, OwnershipRead } from '@/types/dispatch'
import type { FetchItemsByNumberParams, GitHubRepoRef, ItemsByNumberFetch, PipelineItemKind } from '@/types/github'
import type { MirrorItemParams, PipelineStateStore, StoredItem } from '@/types/pipeline-state'
import type { ApplyLabelsParams, AuditEntry, LabelAuditEntry, LabelWriteRequest, ObservedItem, OwnershipKind, WriteOutcome, WriteStateParams } from '@/types/writes'
import { stateMoved } from '@/types/writes'
import { mirrorVocabularyOf, type MirrorVocabulary } from '@/utils/labels/display'
import type { LabelVocabulary } from '@/utils/labels/vocabulary'
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

/** What one `writeState` call learned on the way, for the incident it may raise. */
interface WriteFacts {
  head: string | null
  observed: ObservedItem | null
}

interface StateWriter {
  readonly writeState: (params: WriteStateParams) => Promise<WriteOutcome>
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

/** The ticket of a pull request, or the pull request of a ticket — the other half of what GitHub shows for one change. */
function counterpartOf(items: readonly StoredItem[], item: StoredItem): StoredItem | null {
  return item.kind === 'pull-request' ? linkedIssueOf(items, item) : linkedPullRequestOf(items, item.number)
}

export function createStateWriter(deps: StateWriterDeps): StateWriter {
  async function audit(ctx: MirrorContext, target: { readonly kind: PipelineItemKind; readonly number: number }, action: string, ownership: OwnershipKind, precondition: LabelAuditEntry['precondition'], observed: ObservedItem | null, outcome: WriteOutcome): Promise<WriteOutcome> {
    const entry: LabelAuditEntry = { at: deps.now().toISOString(), repo: ctx.repo, repoId: ctx.repoId, kind: target.kind, number: target.number, action, ownership, precondition, observed, call: null, commentBytes: null, result: outcome, ...(ctx.writeId === undefined ? {} : { writeId: ctx.writeId }) }
    await deps.appendAudit(ctx.auditDir, entry)
    return outcome
  }

  function readOwner(ctx: MirrorContext): Promise<OwnershipRead> {
    return deps.readOwnership({ repoRoot: ctx.repoRoot, repo: ctx.repo })
  }

  function namesFor(ctx: MirrorContext, items: readonly StoredItem[], item: StoredItem, mode: 'state' | 'merged'): { readonly desired: readonly string[]; readonly all: readonly string[] } {
    if (ctx.mirror.kind === 'display') {
      const keys = mode === 'merged' ? mergedDisplayKeys() : displayKeysOf(item, item.kind === 'issue' ? linkedPullRequestOf(items, item.number) : null)
      return { desired: displayNamesOf(ctx.mirror.labels, keys), all: allDisplayNames(ctx.mirror.labels) }
    }
    return { desired: legacyNamesOf(ctx.vocabulary, mode === 'merged' ? mergedKeysOf(item) : legacyKeysOf(item)), all: allLegacyNames(ctx.vocabulary) }
  }

  function labelsCall(ctx: MirrorContext, item: StoredItem, action: string, diff: { readonly addNames: readonly string[]; readonly removeNames: readonly string[] }, assignees: { readonly add: readonly string[]; readonly remove: readonly string[] }, observed: ObservedItem): Promise<WriteOutcome> {
    return deps.applyLabels({
      repo: ctx.repo,
      repoId: ctx.repoId,
      kind: item.kind,
      number: item.number,
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

  async function recordOutcome(ctx: MirrorContext, ref: { readonly kind: PipelineItemKind; readonly number: number }, outcome: WriteOutcome): Promise<void> {
    await deps.store.recordMirror(ctx.repoId, ref, settled(outcome) ? null : { at: deps.now().toISOString(), outcome })
  }

  /** Records the call's incident once its outcome is known; a failure here never changes the outcome. */
  async function raiseIncident(request: LabelWriteRequest, writeId: string, outcome: WriteOutcome, seen: WriteFacts): Promise<void> {
    try {
      let intent: IncidentIntent | null = request.incident ?? null
      if (intent !== null) {
        const observedHead = intent.inputs.observedHead
        const moved = typeof observedHead === 'string' && seen.head !== null && observedHead !== seen.head
        intent = { ...intent, ...(moved ? { bucket: 'stale-snapshot' as const, condition: 'head-moved', decision: { ...intent.decision, intended: intent.bucket } } : {}), inputs: { ...intent.inputs, writeHead: seen.head } }
      } else if (!stateMoved(outcome)) {
        intent = refusedWriteIntent(request, outcome.kind, seen.observed, { present: request.expect.present, absent: request.expect.absent, assignees: request.expect.assignees })
      }
      if (intent === null) return
      const tick = typeof intent.inputs.snapshotAt === 'string' ? intent.inputs.snapshotAt : null
      await deps.recordIncident(draftOf(intent, { repo: request.repo, kind: request.kind, number: request.number }, { kind: outcome.kind }, { audit: [writeId], tick }))
    } catch {
      // Best-effort by design: a lost incident costs analysis, a failed write costs the pipeline.
    }
  }

  async function writeState(params: WriteStateParams): Promise<WriteOutcome> {
    const writeId = deps.newId()
    const seen: WriteFacts = { head: null, observed: null }
    const outcome = await attemptWrite(params, writeId, seen)
    await raiseIncident(params.request, writeId, outcome, seen)
    return outcome
  }

  async function attemptWrite(params: WriteStateParams, writeId: string, seen: WriteFacts): Promise<WriteOutcome> {
    const { request } = params
    const ctx: MirrorContext = { repo: request.repo, repoId: request.repoId, vocabulary: request.vocabulary, mirror: request.mirror, repoRoot: params.repoRoot, auditDir: params.auditDir, gh: params.gh, git: params.git, pathOps: params.pathOps, fetchItemsByNumber: params.fetchItemsByNumber, writeId }
    const target = { kind: request.kind, number: request.number }
    const present = resolveKeys(request.vocabulary, request.expect.present)
    const absent = resolveKeys(request.vocabulary, request.expect.absent)
    const precondition: LabelAuditEntry['precondition'] = { present: present.names, absent: absent.names, assignees: request.expect.assignees }

    const ownership = await readOwner(ctx)
    if (ownership.kind === 'unreadable') return audit(ctx, target, request.action, 'unreadable', precondition, null, { kind: 'ownership-unreadable', path: ownership.path, message: ownership.message })
    const log = (observed: ObservedItem | null, outcome: WriteOutcome): Promise<WriteOutcome> => {
      seen.observed = observed
      return audit(ctx, target, request.action, ownership.kind, precondition, observed, outcome)
    }

    const add = resolveKeys(request.vocabulary, request.add)
    const remove = resolveKeys(request.vocabulary, request.remove)
    const unresolved = [...new Set([...present.unresolved, ...absent.unresolved, ...add.unresolved, ...remove.unresolved])]
    if (unresolved.length > 0) return log(null, { kind: 'unresolvable-label', keys: unresolved })

    const before = deps.store.view(request.repoId)
    if (before.kind === 'unseeded') return log(null, { kind: 'state-unsaved', message: UNSEEDED_MESSAGE })
    const stored = before.items.find((item) => item.kind === request.kind && item.number === request.number)
    const linked = request.kind === 'issue' ? linkedPullRequestOf(before.items, request.number)?.number : stored?.issue
    const numbers = linked === undefined || linked === null ? [request.number] : [request.number, linked]

    const read = await (params.fetchItemsByNumber ?? deps.fetchItemsByNumber)({ repo: splitRepo(request.repo), numbers })
    if (!read.ok) return log(null, { kind: 'verify-failed', message: read.message })
    const item = read.resolved.find((candidate) => candidate.number === request.number)
    seen.head = item?.headRefOid ?? null
    const githubSide = observedOf(read, request.number)
    if (item === undefined || githubSide === null) return log(null, { kind: 'item-unavailable' })

    const assignees = evaluate({ presentNames: [], absentNames: [], assignees: request.expect.assignees }, githubSide)
    if (!assignees.satisfied) {
      return log(githubSide, { kind: 'precondition-failed', conflict: { kind: 'precondition-failed', expected: assignees.expected, observed: assignees.observed, readAt: read.fetchedAt } })
    }

    const moved = await deps.store.transition(request.repoId, target, {
      add: request.add,
      remove: request.remove,
      expect: { present: request.expect.present, absent: request.expect.absent },
      action: request.action,
      at: deps.now().toISOString(),
      actor: null,
      issue: request.kind === 'pull-request' ? issueNumberOfBranch(item.headRefName) : null,
    })
    if (!moved.ok) {
      if (moved.reason === 'persist-failed') return log(githubSide, { kind: 'state-unsaved', message: moved.message })
      const names = stateLabelsOf(deps.store.view(request.repoId), request.kind, request.number, request.vocabulary) ?? []
      const observed: ObservedItem = { labels: names, assignees: item.assignees, readAt: read.fetchedAt }
      const verdict = evaluate({ presentNames: present.names, absentNames: absent.names, assignees: { kind: 'any' } }, observed)
      const expected = verdict.satisfied ? [] : verdict.expected
      return log(observed, { kind: 'precondition-failed', conflict: { kind: 'precondition-failed', expected, observed: names, readAt: read.fetchedAt } })
    }

    const after = deps.store.view(request.repoId)
    const written = after.kind === 'store' ? after.items.find((candidate) => candidate.kind === request.kind && candidate.number === request.number) : undefined
    if (after.kind !== 'store' || written === undefined) return { kind: 'mirror-failed', mirror: { kind: 'state-unsaved', message: UNSEEDED_MESSAGE } }

    const names = namesFor(ctx, after.items, written, 'state')
    const outcome = await labelsCall(ctx, written, request.action, mirrorDiff(names.desired, names.all, githubSide.labels), { add: request.addAssignees, remove: request.removeAssignees }, githubSide)
    await recordOutcome(ctx, target, outcome)

    const counterpart = ctx.mirror.kind === 'display' ? counterpartOf(after.items, written) : null
    if (counterpart !== null) await mirrorCounterpart(ctx, after.items, counterpart, request.action, observedOf(read, counterpart.number))

    return settled(outcome) ? outcome : { kind: 'mirror-failed', mirror: outcome }
  }

  /** Never changes the write's own outcome: a failure here is recorded on the counterpart and retried by the poll. */
  async function mirrorCounterpart(ctx: MirrorContext, items: readonly StoredItem[], counterpart: StoredItem, action: string, known: ObservedItem | null): Promise<void> {
    const observed = known ?? observedOf(await (ctx.fetchItemsByNumber ?? deps.fetchItemsByNumber)({ repo: splitRepo(ctx.repo), numbers: [counterpart.number] }), counterpart.number)
    if (observed === null) return
    const names = namesFor(ctx, items, counterpart, 'state')
    const diff = mirrorDiff(names.desired, names.all, observed.labels)
    if (diff.addNames.length === 0 && diff.removeNames.length === 0) return
    const outcome = await labelsCall(ctx, counterpart, action, diff, { add: [], remove: [] }, observed)
    await recordOutcome(ctx, counterpart, outcome)
  }

  async function mirrorItem(params: MirrorItemParams): Promise<WriteOutcome> {
    const { entry, ref, action } = params
    const ctx: MirrorContext = { repo: entry.config.repo, repoId: entry.id, vocabulary: entry.config.vocabulary, mirror: mirrorVocabularyOf(entry.config), repoRoot: entry.path, auditDir: params.auditDir }
    const ownership = await readOwner(ctx)
    if (ownership.kind === 'unreadable') return audit(ctx, ref, action, 'unreadable', null, null, { kind: 'ownership-unreadable', path: ownership.path, message: ownership.message })

    const view = deps.store.view(entry.id)
    const item = view.kind === 'store' ? view.items.find((candidate) => candidate.kind === ref.kind && candidate.number === ref.number) : undefined
    if (view.kind !== 'store' || item === undefined) return audit(ctx, ref, action, ownership.kind, null, null, { kind: 'item-unavailable' })

    const read = await deps.fetchItemsByNumber({ repo: splitRepo(ctx.repo), numbers: [ref.number] })
    const observed = observedOf(read, ref.number)
    if (!read.ok || observed === null) {
      const outcome: WriteOutcome = read.ok ? { kind: 'item-unavailable' } : { kind: 'verify-failed', message: read.message }
      await audit(ctx, ref, action, ownership.kind, null, null, outcome)
      await recordOutcome(ctx, ref, outcome)
      return outcome
    }

    const names = namesFor(ctx, view.items, item, params.mode)
    const outcome = await labelsCall(ctx, item, action, mirrorDiff(names.desired, names.all, observed.labels), { add: [], remove: [] }, observed)
    await recordOutcome(ctx, ref, outcome)
    return outcome
  }

  return { writeState, mirrorItem }
}
