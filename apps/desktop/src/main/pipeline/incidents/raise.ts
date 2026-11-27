// Pure: the intent each raising site builds from facts it already holds. A signature is bucket, stage and condition, never a number, SHA or time, so a recurrence collapses into one group.
import { ownBranchPullRequestOf } from '@/main/pipeline/tick/adopt'
import { itemInputs } from '@/main/pipeline/incidents/snapshot'
import type { StageLaunchFailureCause, StageSnapshot, WriteObservation } from '@/types/dispatch'
import type { IncidentBucket, IncidentDraft, IncidentInputs, IncidentIntent, IncidentOutcome, IncidentRelated, RecordIncident } from '@/types/incidents'
import type { PipelineItemKind } from '@/types/github'
import type { ReconciledItem, RepositoryState } from '@/types/state'
import type { RepoId } from '@/utils/repos'
import { isTransientNetworkFailure, SETTLE_FAILED_DETAIL } from '@/main/pipeline/handback'
import type { StageHandback, StageOutcome, StageOutcomeKind } from '@/types/stage-session'
import type { HandoffRefusal, StageAgent } from '@/types/tick'

/** A session that ends this soon after it started never did the work. */
export const FAST_END_MS = 15_000

export function signatureOf(bucket: IncidentBucket, stage: string, condition: string): string {
  return `${bucket}:${stage}:${condition}`
}

interface PlannedLabels {
  readonly add: readonly string[]
  readonly remove: readonly string[]
  readonly action: string
}

function targetStage(plan: Pick<PlannedLabels, 'add' | 'remove'>): string {
  return plan.add[0] ?? plan.remove[0] ?? 'none'
}

/** The signature stage every observation escalation files under. */
const ESCALATED_STAGE = 'needsHuman'

function observedInputs(item: ReconciledItem, snapshotAt: string | null): IncidentInputs {
  return { ...itemInputs(item), observedHead: item.headRefOid, snapshotAt }
}

/** `null` for an observation that is routine, not an anomaly. */
export function observationIntent(observation: WriteObservation, item: ReconciledItem, plan: { readonly action: string }, snapshotAt: string | null): IncidentIntent | null {
  const inputs = observedInputs(item, snapshotAt)
  const decision = { action: plan.action, detail: observation.kind, intended: null }
  switch (observation.kind) {
    case 'liveness-reset':
      return { bucket: 'liveness-reset', stage: observation.stage, condition: 'stalled-confirmed', decision, inputs }
    case 'zero-diff':
      return { bucket: 'duplicate-head', stage: ESCALATED_STAGE, condition: 'zero-diff', decision, inputs }
    case 'cycle-cap':
    case 'integration-red':
    case 'refresh-stuck':
      return { bucket: 'escalation', stage: ESCALATED_STAGE, condition: observation.kind, decision, inputs }
    case 'withdraw-approval':
      return observation.route === 'human' ? { bucket: 'escalation', stage: ESCALATED_STAGE, condition: observation.kind, decision, inputs } : null
    default:
      return null
  }
}

/** An over-budget candidate sent to a human. `observedHead` is the head the decision read. */
export function budgetIntent(stage: string, headRefOid: string | null): IncidentIntent {
  return { bucket: 'escalation', stage: 'needsHuman', condition: 'budget', decision: { action: 'budget-escalate', detail: 'budget', intended: null }, inputs: { stage, observedHead: headRefOid, snapshotAt: null } }
}

/** A stage's hand-back write that leaves the ticket `blocked` or `needsHuman`. */
export function stageHandbackIntent(landed: { readonly key: 'blocked' | 'needsHuman'; readonly action: string }, agent: StageAgent, ticket: number, snapshotItem: ReconciledItem | null, snapshotAt: string | null): IncidentIntent {
  const stage = landed.key
  const decision = { action: landed.action, detail: agent, intended: null }
  const pullRequest = agent === 'impl' && snapshotItem !== null ? ownBranchPullRequestOf(snapshotItem) : null
  if (pullRequest !== null && snapshotItem !== null) {
    return { bucket: 'existing-work', stage, condition: 'pr-open', decision, inputs: { ...itemInputs(snapshotItem), issue: ticket, snapshotAt }, subject: { kind: 'pull-request', number: pullRequest.number } }
  }
  return { bucket: 'escalation', stage, condition: landed.action, decision, inputs: { agent, issue: ticket, snapshotAt } }
}

interface SessionRecord {
  readonly agent: StageAgent
  readonly stage: string
}

export function launchFailedIntent(record: SessionRecord, cause: StageLaunchFailureCause | `claim-${string}`): IncidentIntent {
  const bucket: IncidentBucket = cause === 'leftover-worktree' ? 'leftover-worktree' : 'launch-failed'
  return { bucket, stage: record.agent, condition: cause, decision: { action: 'stage-launch', detail: cause, intended: null }, inputs: { agent: record.agent, stage: record.stage } }
}

interface EndedSession extends SessionRecord {
  readonly sessionKey: string | null
  readonly claudeSessionId: string | null
  readonly at: string
}

function sessionInputs(record: EndedSession, outcomeKind: StageOutcomeKind, handback: StageHandback | null): IncidentInputs {
  return { sessionKey: record.sessionKey, claudeSessionId: record.claudeSessionId, agent: record.agent, stage: record.stage, outcome: outcomeKind, handback: handback?.token ?? null }
}

/** A session that ended within `FAST_END_MS` of its start; `null` otherwise. */
export function fastEndIntent(record: EndedSession, outcomeKind: StageOutcomeKind, handback: StageHandback | null, nowMs: number): IncidentIntent | null {
  const lived = nowMs - Date.parse(record.at)
  if (Number.isNaN(lived) || lived >= FAST_END_MS) return null
  return { bucket: 'launch-failed', stage: record.agent, condition: 'ended-fast', decision: { action: 'stage-ended', detail: outcomeKind, intended: null }, inputs: { ...sessionInputs(record, outcomeKind, handback), livedMs: lived } }
}

const INTERRUPTED: readonly StageOutcomeKind[] = ['interrupted', 'error', 'usage-limit']

/** A stage that stopped without handing back; `network` says whether the failure was transient. */
export function interruptedIntent(record: EndedSession, outcomeKind: StageOutcomeKind, reason: 'network' | 'settle-failed' | 'usage-limit' | 'error' | 'interrupted'): IncidentIntent | null {
  if (!INTERRUPTED.includes(outcomeKind)) return null
  const bucket: IncidentBucket = reason === 'network' ? 'network-interrupt' : 'unknown'
  return { bucket, stage: record.agent, condition: reason, decision: { action: 'stage-ended', detail: outcomeKind, intended: null }, inputs: sessionInputs(record, outcomeKind, null) }
}

function interruptReason(outcome: StageOutcome): Parameters<typeof interruptedIntent>[2] {
  if (outcome.kind === 'usage-limit') return 'usage-limit'
  if (outcome.kind === 'interrupted') return isTransientNetworkFailure(outcome.detail) ? 'network' : 'interrupted'
  return outcome.detail?.startsWith(SETTLE_FAILED_DETAIL) === true ? 'settle-failed' : 'error'
}

/** Every incident a stage's end raises: one for a session that ended almost at once, one for a stop without a hand-back. */
export function endedIntents(record: EndedSession, outcome: StageOutcome, nowMs: number): readonly IncidentIntent[] {
  return [fastEndIntent(record, outcome.kind, outcome.handback, nowMs), interruptedIntent(record, outcome.kind, interruptReason(outcome))].filter((intent): intent is IncidentIntent => intent !== null)
}

interface HandoffRefused {
  readonly agent: StageAgent
  readonly sessionKey: string
  readonly stage: string
}

/** A hand-back write the app gave up on. The refusal's detail text is never carried. */
export function handoffRefusalIntent(record: HandoffRefused, reason: HandoffRefusal, attempts: number, retryable: boolean): IncidentIntent {
  return { bucket: 'refused-write', stage: record.agent, condition: `handoff-${reason}`, decision: { action: 'stage-handback', detail: reason, intended: null }, inputs: { sessionKey: record.sessionKey, attempts, retryable, stage: record.stage } }
}

/** A write `writeState` refused with no raising site of its own. */
export function refusedWriteIntent(planned: { readonly add: readonly string[]; readonly remove: readonly string[]; readonly action: string }, outcomeKind: string, observed: { readonly labels: readonly string[]; readonly assignees: readonly string[] } | null, precondition: IncidentInputs): IncidentIntent {
  return {
    bucket: 'refused-write',
    stage: targetStage(planned),
    condition: outcomeKind,
    decision: { action: planned.action, detail: null, intended: null },
    inputs: { precondition, labels: observed?.labels ?? null, assignees: observed?.assignees ?? null },
  }
}

export function draftOf(intent: IncidentIntent, ref: { readonly repo: string; readonly kind: PipelineItemKind; readonly number: number }, outcome: IncidentOutcome | null, related: IncidentRelated): IncidentDraft {
  const subject = intent.subject ?? { kind: ref.kind, number: ref.number }
  return { ...intent, repo: ref.repo, kind: subject.kind, number: subject.number, outcome, related }
}

export function noRelated(): IncidentRelated {
  return { audit: [], tick: null }
}

/** Records an intent against a ticket of a repository known by name; never rejects, and records nothing for an unknown repository. */
export function createRaiser(record: RecordIncident, repoNameOf: (repoId: RepoId) => string | undefined) {
  return (repoId: RepoId, ref: { readonly number: number; readonly kind: PipelineItemKind }, intent: IncidentIntent, outcome: IncidentOutcome): void => {
    const repo = repoNameOf(repoId)
    if (repo !== undefined) void record(draftOf(intent, { repo, kind: ref.kind, number: ref.number }, outcome, noRelated())).catch(() => undefined)
  }
}

/** The tick's view of one ticket and the instant GitHub was read, for the incident a hand-back write may raise. */
export function stageSnapshotOf(repository: Extract<RepositoryState, { readonly ok: true }> | undefined, number: number): StageSnapshot {
  return { item: repository?.items.find((candidate) => candidate.number === number) ?? null, at: repository !== undefined && 'at' in repository.freshness.github ? repository.freshness.github.at : null }
}
