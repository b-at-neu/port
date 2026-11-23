// The seam between the main-process dispatch loop and whatever actually
// starts a stage session — no I/O, no SDK import.
import type { HostedSessionSnapshot, SessionKey } from '@/types/hosting'
import type { EndedStage, TickActionable } from '@/types/tick'
import type { StageRecord } from '@/types/dispatch'
import type { StageLabelResult } from '@/types/stage-labels'
import type { PipelineItemKind, ResolvedItem } from '@/types/github'
import type { StageWorktreeTarget } from '@/types/workspace'

// Hosted snapshots whose `phase !== 'ended'` — operator and stage sessions
// alike; stage sessions share the hosted cap.
export function liveCount(snapshots: readonly HostedSessionSnapshot[]): number {
  return snapshots.filter((s) => s.phase !== 'ended').length
}

export function freeSlots(limit: number, snapshots: readonly HostedSessionSnapshot[]): number {
  return Math.max(0, limit - liveCount(snapshots))
}

export function targetOf(kind: PipelineItemKind, resolved: ResolvedItem | undefined): StageWorktreeTarget {
  if (kind === 'pull-request') return { kind: 'pr', headRefName: resolved?.headRefName ?? null }
  return { kind: 'issue', title: resolved?.title ?? '' }
}

export function newStageRecord(candidate: Pick<TickActionable, 'agent' | 'number' | 'kind' | 'trigger'>, state: 'started' | 'failed', at: string, sessionKey: SessionKey | null, detail: string | null): StageRecord {
  return { sessionKey, agent: candidate.agent, number: candidate.number, kind: candidate.kind, trigger: candidate.trigger, state, at, endedAt: null, detail, outcome: null, claudeSessionId: null, operatorJoinedAt: null }
}

/** How long an ended session whose hand-back has not been classified still counts as live. Bounds a launcher that never reports an outcome. */
export const SETTLE_GRACE_MS = 120_000

// A `started` record whose handle is `null` or `ended` becomes `ended`, stamped with `now`. `claudeSessionId`/`operatorJoinedAt` are copied off the snapshot while it exists, including on the pass that marks the record `ended` — once the handle is gone, the last values stay.
export function refreshRecords(records: readonly StageRecord[], snapshotOf: (sessionKey: SessionKey) => HostedSessionSnapshot | null, now: string): readonly StageRecord[] {
  return records.map((record) => {
    if (record.state !== 'started' || record.sessionKey === null) return record
    const snap = snapshotOf(record.sessionKey)
    if (snap === null) return { ...record, state: 'ended' as const, endedAt: now }
    const withSnap = { ...record, claudeSessionId: snap.claudeSessionId, operatorJoinedAt: snap.operatorJoinedAt }
    return snap.phase !== 'ended' ? withSnap : { ...withSnap, state: 'ended' as const, endedAt: now }
  })
}

// The `${agent} #${number}` descriptions of sessions that ended but whose hand-back is still being classified or written: an ended record with no outcome inside the grace, or a number whose write is pending. A settling session is live — its hand-back is about to land.
export function settlingDescriptions(records: readonly StageRecord[], pendingNumbers: ReadonlySet<number>, now: Date): readonly string[] {
  const out: string[] = []
  for (const record of records) {
    const endedAt = record.endedAt === null ? Number.NaN : Date.parse(record.endedAt)
    const classifying = record.state === 'ended' && record.outcome === null && !Number.isNaN(endedAt) && now.getTime() - endedAt < SETTLE_GRACE_MS
    if (classifying || (record.state !== 'failed' && pendingNumbers.has(record.number))) out.push(`${record.agent} #${String(record.number)}`)
  }
  return out
}

// This repository's own ended stage-session records, newest per number — `main/pipeline/tick/repair.ts`'s session-shape evidence, projected here rather than in `dispatcher.ts` to keep that file under its line limit.
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

// Drops the oldest non-live records first, never a live one, down to `limit`.
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
