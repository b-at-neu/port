import type { HostedSessionSnapshot, SessionKey } from '@/types/hosting'
import type { BudgetStatus, DispatchOwner, DispatcherState, ObservationRecord, OwnershipRead, RepoDispatchStatus, RunState, StageRecord, StageSessionSummary } from '@/types/dispatch'
import type { InterruptedStage, StageDenial } from '@/types/stage'
import type { RunChange, StageLabelResult } from '@/types/stage-labels'
import type { EndedStage, TickActionable } from '@/types/tick'
import type { RepoId } from '@/utils/repos'

/** The cockpit's own tick floor — a slow label swap must never look like "nothing sent yet" and double-dispatch the same candidate within one tick's worth of time. */
export const REDISPATCH_FLOOR_MS = 270_000

/** How long an ended session whose hand-back has not been classified still counts as live. Bounds a launcher that never reports an outcome. */
export const SETTLE_GRACE_MS = 120_000

/** What the dispatch loop keeps per repository besides its runs, which `Ticket.runs` holds. */
export interface RepoDispatcherState {
  owner: DispatchOwner
  dispatcherState: DispatcherState
  runState: RunState
  ownedSince: string | null
  unreadableMessage: string | null
  budgetReset: boolean
  budgetHolds: Map<number, number>
  budget: BudgetStatus | null
  observed: ObservationRecord[]
  observedWriteAt: Map<number, string>
  /** Whether this boot's unwritten hand-backs were settled; they are, once, on the first owned pass. */
  replayed: boolean
}

export function emptyRepoState(): RepoDispatcherState {
  return {
    owner: 'none',
    dispatcherState: { kind: 'idle' },
    runState: 'paused',
    ownedSince: null,
    unreadableMessage: null,
    budgetReset: false,
    budgetHolds: new Map(),
    budget: null,
    observed: [],
    observedWriteAt: new Map(),
    replayed: false,
  }
}

export function ownerOf(ownership: OwnershipRead): DispatchOwner {
  return ownership.kind === 'absent' ? 'none' : ownership.kind
}

export function activeOrIdle(records: readonly StageRecord[]): DispatcherState {
  return records.length > 0
    ? { kind: 'active', recent: records.map((r) => ({ agent: r.agent, number: r.number, kind: r.kind, trigger: r.trigger, state: r.state, at: r.at, detail: r.detail, outcome: r.outcome, sessionKey: r.sessionKey, claudeSessionId: r.claudeSessionId, operatorJoinedAt: r.operatorJoinedAt })) }
    : { kind: 'idle' }
}

interface RunSync {
  readonly runId: string
  readonly change: RunChange
}

/** What the hosted sessions say about the runs still started: a session that is gone or ended ends its run, and an operator's first message into one is recorded. `ended` leaves the outcome untouched. */
export function syncChanges(records: readonly StageRecord[], snapshotOf: (sessionKey: SessionKey) => HostedSessionSnapshot | null): readonly RunSync[] {
  return records.flatMap((record): RunSync[] => {
    if (record.state !== 'started' || record.sessionKey === null) return []
    const snap = snapshotOf(record.sessionKey)
    const joined: RunSync[] = snap !== null && snap.operatorJoinedAt !== null && record.operatorJoinedAt === null ? [{ runId: record.runId, change: { kind: 'joined', at: snap.operatorJoinedAt } }] : []
    const ended: RunSync[] = snap === null || snap.phase === 'ended' ? [{ runId: record.runId, change: { kind: 'ended', outcome: null } }] : []
    return [...joined, ...ended]
  })
}

/** Drops the oldest non-live records first, never a live one, down to `limit`. */
export function boundRecords(records: readonly StageRecord[], limit: number): readonly StageRecord[] {
  if (records.length <= limit) return records
  const live = records.filter((r) => r.state === 'started')
  const rest = records.filter((r) => r.state !== 'started')
  const overflow = records.length - limit
  const dropped = Math.min(overflow, rest.length)
  const keptRest = rest.slice(dropped)
  const keptSet = new Set([...live, ...keptRest])
  return records.filter((r) => keptSet.has(r))
}

interface SelectDispatchesParams {
  readonly dispatchable: readonly TickActionable[]
  /** This repository's own bounded recent list, every state — the floor applies to all three. */
  readonly recent: readonly StageRecord[]
  readonly now: Date
}

/** Drops any candidate already launched within `REDISPATCH_FLOOR_MS`. Everything else passes through in the candidates' own order. */
export function selectDispatches(params: SelectDispatchesParams): readonly TickActionable[] {
  const { dispatchable, recent, now } = params
  return dispatchable.filter((candidate) => {
    const matches = recent.filter((r) => r.agent === candidate.agent && r.number === candidate.number)
    if (matches.length === 0) return true
    const newest = matches.reduce((a, b) => (Date.parse(a.at) > Date.parse(b.at) ? a : b))
    return now.getTime() - Date.parse(newest.at) >= REDISPATCH_FLOOR_MS
  })
}

/** The `${agent} #${number}` descriptions of sessions that ended but whose hand-back is still being classified or written: an ended record with no outcome inside the grace, or a number whose write is pending. A settling session is live — its hand-back is about to land. */
export function settlingDescriptions(records: readonly StageRecord[], pendingNumbers: ReadonlySet<number>, now: Date): readonly string[] {
  const out: string[] = []
  for (const record of records) {
    const endedAt = record.endedAt === null ? Number.NaN : Date.parse(record.endedAt)
    const classifying = record.state === 'ended' && record.outcome === null && !Number.isNaN(endedAt) && now.getTime() - endedAt < SETTLE_GRACE_MS
    if (classifying || (record.state !== 'failed' && pendingNumbers.has(record.number))) out.push(`${record.agent} #${String(record.number)}`)
  }
  return out
}

/** This repository's own ended stage-session records, newest per number — `main/pipeline/tick/repair.ts`'s session-shape evidence. */
export function endedStagesOf(records: readonly StageRecord[], resultFor: (sessionKey: SessionKey) => StageLabelResult | null): readonly EndedStage[] {
  const newestByNumber = new Map<number, EndedStage>()
  for (const record of records) {
    if (record.state === 'started' || record.outcome === null) continue
    const labels = record.sessionKey === null ? null : resultFor(record.sessionKey)
    const candidate: EndedStage = { agent: record.agent, number: record.number, outcome: record.outcome.kind, at: record.at, labels }
    const existing = newestByNumber.get(record.number)
    if (existing === undefined || Date.parse(candidate.at) > Date.parse(existing.at)) newestByNumber.set(record.number, candidate)
  }
  return [...newestByNumber.values()]
}

export function liveStagesOf(records: readonly StageRecord[]): readonly string[] {
  return records.filter((r) => r.state === 'started').map((r) => `${r.agent} #${String(r.number)}`)
}

/** `null` unless this app owns the repository — a cockpit that is not dispatching has no liveness to report. */
export function stageLivenessOf(state: RepoDispatcherState | undefined, records: readonly StageRecord[], pendingNumbers: ReadonlySet<number>, interrupted: readonly InterruptedStage[], now: Date): { readonly live: readonly string[]; readonly interrupted: readonly string[] } | null {
  if (state === undefined || state.owner !== 'app') return null
  return { live: [...liveStagesOf(records), ...settlingDescriptions(records, pendingNumbers, now)], interrupted: interrupted.map((i) => `${i.agent} #${String(i.number)}`) }
}

export function liveStageSessionsOf(repoIds: readonly RepoId[], recordsOf: (repoId: RepoId) => readonly StageRecord[], nameOf: (repoId: RepoId) => string): readonly StageSessionSummary[] {
  return repoIds.flatMap((repoId) =>
    recordsOf(repoId)
      .filter((record) => record.state === 'started')
      .map((record) => ({ agent: record.agent, number: record.number, trigger: record.trigger, repoName: nameOf(repoId) })),
  )
}

export function statusOf(states: ReadonlyMap<RepoId, RepoDispatcherState>, denialsOf: (repoId: RepoId) => readonly StageDenial[], interruptedOf: (repoId: RepoId) => readonly InterruptedStage[]): readonly RepoDispatchStatus[] {
  return [...states.entries()].map(([repoId, s]) => ({
    repoId,
    owner: s.owner,
    state: s.dispatcherState,
    runState: s.runState,
    ownedSince: s.ownedSince,
    unreadableMessage: s.unreadableMessage,
    budget: s.budget,
    observed: s.observed,
    denials: denialsOf(repoId),
    interrupted: interruptedOf(repoId),
  }))
}
