// Renderer-safe contract for the incident log: every anomaly the app detects, with the bounded inputs behind the decision and a bucket assigned where it was raised.
import type { PipelineItemKind } from '@/types/github'

export const INCIDENT_BUCKETS = [
  'stale-snapshot',
  'liveness-reset',
  'duplicate-head',
  'existing-work',
  'leftover-worktree',
  'network-interrupt',
  'refused-write',
  'launch-failed',
  'escalation',
  'unknown',
] as const

export type IncidentBucket = (typeof INCIDENT_BUCKETS)[number]

/** The most UTF-8 bytes one incident's `inputs` may serialize to. */
export const INCIDENT_INPUTS_MAX_BYTES = 4096

/** The most records one `incidents:list` read returns, newest kept. */
export const INCIDENT_LIST_LIMIT = 200

/** The most distinct tickets one group names. */
export const INCIDENT_GROUP_ITEMS_LIMIT = 50

export type IncidentInputs = Readonly<Record<string, unknown>>

export interface IncidentDecision {
  /** What the app did or refused to do, in the audit log's own verb. */
  readonly action: string
  /** The observation or hand-back kind behind it, kept out of the signature. */
  readonly detail: string | null
  /** The bucket the raising code asked for, when the write-time check moved it. */
  readonly intended: IncidentBucket | null
}

export interface IncidentSubject {
  readonly kind: PipelineItemKind
  readonly number: number
}

/** What a raising site knows before the write's outcome exists. `stage` and `condition` never carry a number, SHA or time. */
export interface IncidentIntent {
  readonly bucket: IncidentBucket
  readonly stage: string
  readonly condition: string
  readonly decision: IncidentDecision
  readonly inputs: IncidentInputs
  /** Overrides the written item as the incident's subject. */
  readonly subject?: IncidentSubject
}

export interface IncidentRelated {
  readonly audit: readonly string[]
  /** The GitHub read instant of the tick the decision used. */
  readonly tick: string | null
}

export interface IncidentOutcome {
  readonly kind: string
}

/** An intent placed on a ticket, with the outcome it produced. */
export interface IncidentDraft extends IncidentIntent {
  readonly repo: string
  readonly number: number
  readonly kind: PipelineItemKind
  readonly outcome: IncidentOutcome | null
  readonly related: IncidentRelated
}

/** One line of `incidents.jsonl`. */
export interface IncidentRecord {
  readonly v: 1
  readonly id: string
  readonly at: string
  readonly repo: string
  readonly number: number
  readonly kind: PipelineItemKind
  readonly bucket: IncidentBucket
  readonly signature: string
  readonly decision: IncidentDecision
  readonly inputs: IncidentInputs
  readonly outcome: IncidentOutcome | null
  readonly related: IncidentRelated
  readonly resolvedBy: string | null
}

/** Never rejects: a lost incident costs analysis, a failed write costs the pipeline. */
export type RecordIncident = (draft: IncidentDraft) => Promise<void>

export type IncidentReadFailureKind = 'permission-denied' | 'too-large' | 'io'

/** Older entries were dropped to stay within retention; `through` is the newest dropped `at`. */
export interface IncidentPruned {
  readonly count: number
  readonly through: string
}

export type IncidentRead =
  | { readonly ok: true; readonly records: readonly IncidentRecord[]; readonly malformed: number; readonly pruned: IncidentPruned | null; readonly readAt: string }
  | { readonly ok: false; readonly kind: IncidentReadFailureKind; readonly message: string; readonly readAt: string }

export interface IncidentItemRef {
  readonly repo: string
  readonly kind: PipelineItemKind
  readonly number: number
}

export interface IncidentGroup {
  readonly signature: string
  readonly bucket: IncidentBucket
  readonly stage: string
  readonly condition: string
  readonly count: number
  readonly firstAt: string
  readonly lastAt: string
  readonly items: readonly IncidentItemRef[]
  readonly droppedItems: number
}

export type IncidentGroupsRead =
  | { readonly ok: true; readonly groups: readonly IncidentGroup[]; readonly malformed: number; readonly pruned: IncidentPruned | null; readonly readAt: string }
  | { readonly ok: false; readonly kind: IncidentReadFailureKind; readonly message: string; readonly readAt: string }

export type IncidentListRead =
  | { readonly ok: true; readonly records: readonly IncidentRecord[]; readonly readAt: string }
  | { readonly ok: false; readonly kind: IncidentReadFailureKind; readonly message: string; readonly readAt: string }

/** The file an export writes. */
export interface IncidentExportDocument {
  readonly v: 1
  readonly exportedAt: string
  readonly repo: string | null
  readonly groups: readonly IncidentGroup[]
  readonly malformed: number
  readonly pruned: IncidentPruned | null
}

export type IncidentExportResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly kind: 'cancelled' }
  | { readonly ok: false; readonly kind: 'io'; readonly message: string }
