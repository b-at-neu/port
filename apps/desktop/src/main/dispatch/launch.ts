// The seam between the main-process dispatch loop and whatever actually
// starts a stage session — no I/O, no SDK import.
import type { HostedSessionSnapshot, SessionKey } from '@/types/hosting'
import type { EndedStage } from '@/types/tick'
import type { StageRecord } from '@/types/dispatch'

// Hosted snapshots whose `phase !== 'ended'` — operator and stage sessions
// alike; stage sessions share the hosted cap.
export function liveCount(snapshots: readonly HostedSessionSnapshot[]): number {
  return snapshots.filter((s) => s.phase !== 'ended').length
}

export function freeSlots(limit: number, snapshots: readonly HostedSessionSnapshot[]): number {
  return Math.max(0, limit - liveCount(snapshots))
}

// A `started` record whose handle is `null` or `ended` becomes `ended`. `claudeSessionId`/`operatorJoinedAt` are copied off the snapshot while it exists, including on the pass that marks the record `ended` — once the handle is gone, the last values stay.
export function refreshRecords(records: readonly StageRecord[], snapshotOf: (sessionKey: SessionKey) => HostedSessionSnapshot | null): readonly StageRecord[] {
  return records.map((record) => {
    if (record.state !== 'started' || record.sessionKey === null) return record
    const snap = snapshotOf(record.sessionKey)
    if (snap === null) return { ...record, state: 'ended' as const }
    const withSnap = { ...record, claudeSessionId: snap.claudeSessionId, operatorJoinedAt: snap.operatorJoinedAt }
    return snap.phase !== 'ended' ? withSnap : { ...withSnap, state: 'ended' as const }
  })
}

// This repository's own ended stage-session records, newest per number — `main/tick/repair.ts`'s session-shape evidence, projected here rather than in `dispatcher.ts` to keep that file under its line limit.
export function endedStagesOf(records: readonly StageRecord[]): readonly EndedStage[] {
  const newestByNumber = new Map<number, EndedStage>()
  for (const record of records) {
    if (record.state === 'started' || record.outcome === null) continue
    const candidate: EndedStage = { agent: record.agent, number: record.number, outcome: record.outcome.kind, at: record.at }
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
