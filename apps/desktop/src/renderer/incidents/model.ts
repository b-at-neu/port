// The one incident group/record → row mapping — pure, no DOM.
import { BUCKET_LABEL } from '@/renderer/incidents/copy'
import type { PillStatus } from '@/types/components'
import type { IncidentBucket, IncidentGroup, IncidentRecord } from '@/types/incidents'

export const BUCKET_TONE: Readonly<Record<IncidentBucket, PillStatus>> = {
  'stale-snapshot': 'danger',
  'duplicate-head': 'danger',
  'existing-work': 'danger',
  'refused-write': 'danger',
  escalation: 'attention',
  'liveness-reset': 'attention',
  'launch-failed': 'attention',
  'leftover-worktree': 'attention',
  'network-interrupt': 'idle',
  unknown: 'idle',
}

export interface IncidentGroupRow {
  readonly signature: string
  readonly bucket: string
  readonly tone: PillStatus
  readonly condition: string
  readonly count: number
  readonly firstAt: string
  readonly lastAt: string
  readonly tickets: string
}

export interface IncidentRecordRow {
  readonly key: string
  readonly at: string
  readonly ticket: string
  readonly action: string
  readonly outcome: string
  /** `<observed> → <at write time>`, only when both heads were recorded. */
  readonly heads: string | null
}

const SHA_LENGTH = 7

function shortSha(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value.slice(0, SHA_LENGTH) : null
}

function ticketsOf(group: IncidentGroup): string {
  const numbers = group.items.map((item) => `#${String(item.number)}`)
  const repos = [...new Set(group.items.map((item) => item.repo))]
  const more = group.droppedItems > 0 ? [`+${String(group.droppedItems)} more`] : []
  return [...numbers, ...more, ...repos].join(' ')
}

/** Groups arrive newest-first from main. */
export function groupRows(groups: readonly IncidentGroup[]): readonly IncidentGroupRow[] {
  return groups.map((group) => ({
    signature: group.signature,
    bucket: BUCKET_LABEL[group.bucket],
    tone: BUCKET_TONE[group.bucket],
    condition: group.condition,
    count: group.count,
    firstAt: group.firstAt,
    lastAt: group.lastAt,
    tickets: ticketsOf(group),
  }))
}

export function recordRow(record: IncidentRecord): IncidentRecordRow {
  const observed = shortSha(record.inputs.observedHead)
  const writeHead = shortSha(record.inputs.writeHead)
  return {
    key: record.id,
    at: record.at,
    ticket: `#${String(record.number)}`,
    action: record.decision.action,
    outcome: record.outcome?.kind ?? 'not written',
    heads: observed !== null && writeHead !== null ? `${observed} → ${writeHead}` : null,
  }
}
