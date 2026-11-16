// Every label write a stage session needs — claim, rollback, hand-back, next turn — through `applyLabels` and nowhere else.
import { fetchItemsByNumber } from '@/main/github/adapter'
import { expectFor, handbackRefusal, pullRequestNumberOf, stageModeFor, transitionFor } from '@/main/dispatch/transitions'
import { applyLabels } from '@/main/writes/apply'
import type { ReadyEntry } from '@/types/actions'
import type { FetchItemsByNumberParams, ItemsByNumberFetch, ResolvedItem } from '@/types/github'
import type { StageEvent, StagePlannedWrite, StageTransition, StageTransitionResult } from '@/types/stage-labels'
import type { HandoffRefusal, TickActionable } from '@/types/tick'
import type { ApplyLabelsParams, LabelWriteRequest, WriteOutcome } from '@/types/writes'
import type { LabelKey, LabelVocabulary } from '@/utils/labels/vocabulary'

export interface StageWriteDeps {
  readonly applyLabels: (params: ApplyLabelsParams) => Promise<WriteOutcome>
  readonly fetchItemsByNumber: (params: FetchItemsByNumberParams) => Promise<ItemsByNumberFetch>
}

export const defaultStageWriteDeps: StageWriteDeps = { applyLabels, fetchItemsByNumber }

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
}

const SETTLED_KINDS: ReadonlySet<WriteOutcome['kind']> = new Set(['applied', 'no-op'])

function roleBearingKeysOf(resolved: ResolvedItem, vocabulary: LabelVocabulary): readonly LabelKey[] {
  return vocabulary.labels.filter((l) => l.role !== 'marker' && resolved.labels.includes(l.name)).map((l) => l.key)
}

function refused(reason: HandoffRefusal, retryable: boolean, detail: string | null = null): StageTransitionResult {
  return { kind: 'refused', reason, retryable, detail }
}

/** A `WriteOutcome` that is not `applied`/`no-op`, as the one refusal a hand-back reports; the four transient kinds are the only retryable ones. */
function refusalOf(outcome: WriteOutcome): StageTransitionResult {
  switch (outcome.kind) {
    case 'precondition-failed':
      return refused('moved', false)
    case 'terminal-owned':
      return refused('terminal-owned', false)
    case 'unresolvable-label':
      return refused('unresolvable-label', false, outcome.keys.join(', '))
    case 'write-failed':
      return refused('write-failed', true, outcome.stderr)
    case 'verify-failed':
      return refused('write-failed', true, outcome.message)
    case 'ownership-unreadable':
      return refused('write-failed', true, outcome.message)
    case 'item-unavailable':
      return refused('write-failed', true, 'the item could not be read')
    case 'applied':
    case 'no-op':
      return { kind: 'applied' }
  }
}

function requestFor(entry: ReadyEntry, planned: StagePlannedWrite, number: number, resolved: ResolvedItem): LabelWriteRequest {
  const { vocabulary } = entry.config
  return {
    repoId: entry.id,
    repo: entry.config.repo,
    kind: planned.itemKind,
    number,
    vocabulary,
    add: planned.add,
    remove: planned.remove,
    addAssignees: [],
    removeAssignees: [],
    expect: expectFor(roleBearingKeysOf(resolved, vocabulary), vocabulary, planned.add, resolved.assignees),
    action: planned.action,
  }
}

/** Applies each planned write in order and stops at the first one that did not settle. */
async function applyWrites(entry: ReadyEntry, transition: StageTransition, itemsByNumber: ReadonlyMap<number, ResolvedItem>, itemNumber: number, prNumber: number | null, auditDir: string, deps: StageWriteDeps): Promise<StageTransitionResult> {
  if (transition.kind === 'refused') return refused(transition.reason, false)
  if (transition.kind === 'none') return { kind: 'applied' }
  for (const planned of transition.writes) {
    const number = planned.numberFrom === 'arg' ? prNumber : itemNumber
    const resolved = number === null ? undefined : itemsByNumber.get(number)
    if (number === null || resolved === undefined) return refused('write-failed', true, 'the item could not be read')
    const outcome = await deps.applyLabels({ request: requestFor(entry, planned, number, resolved), repoRoot: entry.path, auditDir })
    if (!SETTLED_KINDS.has(outcome.kind)) return refusalOf(outcome)
  }
  return { kind: 'applied' }
}

/** Trigger → in-flight, planned from the dispatcher's own re-read so the claim never makes a second read. */
export async function applyStageClaim(params: ApplyStageClaimParams, deps: StageWriteDeps = defaultStageWriteDeps): Promise<StageTransitionResult> {
  const { entry, candidate, resolved } = params
  const observed = roleBearingKeysOf(resolved, entry.config.vocabulary)
  const transition = transitionFor({ event: { kind: 'claim' }, mode: stageModeFor(candidate.agent, candidate.trigger), observed, approvalGate: entry.config.modules.approvalGate })
  return applyWrites(entry, transition, new Map([[candidate.number, resolved]]), candidate.number, null, params.auditDir, deps)
}

function isOpenPullRequestOn(resolved: ResolvedItem | undefined, issueNumber: number): resolved is ResolvedItem {
  return resolved !== undefined && resolved.kind === 'pull-request' && resolved.state === 'OPEN' && (resolved.headRefName ?? '').startsWith(`${String(issueNumber)}-`)
}

/** Rollback, hand-back and next-turn writes: a fresh read first, then the table. A `pr-opened` hand-back is verified against the pull request it names before anything is written. */
export async function applyStageTransition(params: ApplyStageTransitionParams, deps: StageWriteDeps = defaultStageWriteDeps): Promise<StageTransitionResult> {
  const { entry, record, event } = params
  const mode = stageModeFor(record.agent, record.trigger)
  const unusable = handbackRefusal(event, mode)
  if (unusable !== null) return refused(unusable, false)
  const handback = event.kind === 'outcome' ? event.handback : null
  const prNumber = mode === 'impl' && handback?.token === 'pr-opened' ? pullRequestNumberOf(handback.arg) : null

  const numbers = prNumber === null ? [record.number] : [record.number, prNumber]
  const fetched = await deps.fetchItemsByNumber({ repo: { owner: entry.config.owner, name: entry.config.name }, numbers })
  if (!fetched.ok) return refused('write-failed', true, fetched.message)
  const itemsByNumber = new Map(fetched.resolved.filter((r) => !fetched.unavailable.includes(r.number)).map((r) => [r.number, r] as const))
  const resolved = itemsByNumber.get(record.number)
  if (resolved === undefined) return refused('write-failed', true, 'the item could not be read')

  const prResolved = prNumber === null ? undefined : itemsByNumber.get(prNumber)
  if (prNumber !== null && !isOpenPullRequestOn(prResolved, record.number)) return refused('pr-unverified', false)

  const { vocabulary } = entry.config
  const transition = transitionFor({
    event,
    mode,
    observed: roleBearingKeysOf(resolved, vocabulary),
    prObserved: prResolved === undefined ? undefined : roleBearingKeysOf(prResolved, vocabulary),
    approvalGate: entry.config.modules.approvalGate,
  })
  return applyWrites(entry, transition, itemsByNumber, record.number, prNumber, params.auditDir, deps)
}
