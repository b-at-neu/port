// The seam between the main-process dispatch loop and whatever actually
// starts a stage session — no I/O, no SDK import.
import type { ReadyEntry } from '../actions'
import type { HostedSessionSnapshot, SessionKey } from '../hosting'
import type { PipelineItemKind } from '../../shared/github/types'
import type { LabelKey } from '../../shared/labels/vocabulary'
import type { StageAgent } from '../../shared/tick/types'

export interface StageLaunchRequest {
  readonly entry: ReadyEntry
  readonly agent: StageAgent
  readonly number: number
  readonly kind: PipelineItemKind
  readonly trigger: LabelKey
  readonly model: string
  readonly prompt: string
}

// `ok: true` promises the store holds a non-`ended` handle for `sessionKey`.
export type StageLaunchResult = { readonly ok: true; readonly sessionKey: SessionKey } | { readonly ok: false; readonly kind: 'at-capacity'; readonly limit: number } | { readonly ok: false; readonly kind: 'failed'; readonly message: string }

export interface StageLauncher {
  launch(request: StageLaunchRequest): Promise<StageLaunchResult>
}

// This app's own per-item launch record, kept internally by the loop.
export interface StageRecord {
  // `null` for a `failed` record — no session was ever created to key.
  readonly sessionKey: SessionKey | null
  readonly agent: StageAgent
  readonly number: number
  readonly kind: PipelineItemKind
  readonly trigger: LabelKey
  readonly state: 'started' | 'ended' | 'failed'
  readonly at: string
  readonly detail: string | null
}

// Hosted snapshots whose `phase !== 'ended'` — operator and stage sessions
// alike; stage sessions share the hosted cap.
export function liveCount(snapshots: readonly HostedSessionSnapshot[]): number {
  return snapshots.filter((s) => s.phase !== 'ended').length
}

export function freeSlots(limit: number, snapshots: readonly HostedSessionSnapshot[]): number {
  return Math.max(0, limit - liveCount(snapshots))
}

// A `started` record whose handle is `null` or `ended` becomes `ended`.
export function refreshRecords(records: readonly StageRecord[], snapshotOf: (sessionKey: SessionKey) => HostedSessionSnapshot | null): readonly StageRecord[] {
  return records.map((record) => {
    if (record.state !== 'started' || record.sessionKey === null) return record
    const snap = snapshotOf(record.sessionKey)
    if (snap !== null && snap.phase !== 'ended') return record
    return { ...record, state: 'ended' as const }
  })
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
