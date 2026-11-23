import { z } from 'zod'
import { repoId, sessionKey } from '@/utils/schemas'
import { STAGE_OUTCOME_KINDS } from '@/types/stage-session'
import type { AssertEqual } from '@/types/assert-type'
import type { WriteOutcome } from '@/types/writes'
import type { LabelKey } from '@/utils/labels/vocabulary'

const timestamp = z.iso.datetime()

export const STAGES = ['plan', 'implement', 'review', 'revise', 'refresh', 'merge'] as const
export const stageSchema = z.enum(STAGES)
export type Stage = z.infer<typeof stageSchema>

export const queueReasonSchema = z.enum(['new', 'changes-requested', 'retry'])
export type QueueReason = z.infer<typeof queueReasonSchema>

export const holdSchema = z.enum(['budget', 'capacity', 'contention', 'paused', 'checks', 'mergeability'])
export type Hold = z.infer<typeof holdSchema>

export const gateSchema = z.enum(['plan-approval', 'merge', 'question', 'permission', 'escalation', 'interrupted'])
export type Gate = z.infer<typeof gateSchema>

export const statusSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('queued'), reason: queueReasonSchema, since: timestamp }),
  z.object({ kind: z.literal('held'), on: holdSchema, detail: z.string() }),
  z.object({ kind: z.literal('running'), runId: z.string().min(1).nullable() }),
  z.object({ kind: z.literal('waiting-on-you'), gate: gateSchema, detail: z.string() }),
  z.object({ kind: z.literal('blocked'), on: z.array(z.int().positive()), reason: z.string() }),
  z.object({ kind: z.literal('done'), at: timestamp }),
])
export type Status = z.infer<typeof statusSchema>
export type StatusKind = Status['kind']

export const STATUS_KINDS = ['queued', 'held', 'running', 'waiting-on-you', 'blocked', 'done'] as const
export const _statusKindsCoverStatus: AssertEqual<(typeof STATUS_KINDS)[number], StatusKind> = true

const WRITE_OUTCOME_KINDS = [
  'applied',
  'no-op',
  'precondition-failed',
  'ownership-unreadable',
  'unresolvable-label',
  'item-unavailable',
  'verify-failed',
  'write-failed',
  'state-unsaved',
  'mirror-failed',
] as const
export const _writeOutcomeKindsCoverWriteOutcome: AssertEqual<(typeof WRITE_OUTCOME_KINDS)[number], WriteOutcome['kind']> = true

export const mirrorFailureSchema = z.object({
  at: timestamp,
  outcome: z.custom<WriteOutcome>(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      'kind' in value &&
      (WRITE_OUTCOME_KINDS as readonly unknown[]).includes(value.kind),
    { message: 'must be a write outcome' },
  ),
})

export const runSchema = z.object({
  id: z.string().min(1),
  stage: stageSchema,
  sessionKey: sessionKey.nullable(),
  claudeSessionId: z.string().min(1).nullable(),
  startedAt: timestamp,
  endedAt: timestamp.nullable(),
  outcome: z.enum(STAGE_OUTCOME_KINDS).nullable(),
  handback: z.object({ token: z.string().min(1), arg: z.string().nullable() }).nullable(),
  costUsd: z.number().min(0).nullable(),
  operatorJoinedAt: timestamp.nullable(),
  failure: z.string().nullable(),
  denials: z.array(z.object({ toolName: z.string(), inputSummary: z.string(), rule: z.string(), at: timestamp })),
})
export type Run = z.infer<typeof runSchema>

export const eventSchema = z.object({
  at: timestamp,
  action: z.string().min(1),
  actor: z.string().nullable(),
  to: z.object({ stage: stageSchema, status: z.enum(STATUS_KINDS) }).nullable(),
  legacy: z.object({ add: z.array(z.string()), remove: z.array(z.string()) }).nullable(),
})
export type Event = z.infer<typeof eventSchema>

export const ticketSchema = z.object({
  rev: z.int().min(0),
  repo: repoId,
  ticket: z.int().positive(),
  pr: z.object({ number: z.int().positive(), approvedAt: timestamp.nullable() }).nullable(),
  stage: stageSchema,
  status: statusSchema,
  autoPlan: z.boolean(),
  reviewCycles: z.int().min(0),
  runs: z.array(runSchema),
  history: z.array(eventSchema),
  mirror: z.object({ written: z.array(z.string()), failure: mirrorFailureSchema.nullable() }),
})
export type Ticket = z.infer<typeof ticketSchema>

export type V1KeyMeaning =
  | { readonly kind: 'state'; readonly stage: Stage; readonly status: StatusKind; readonly reason?: QueueReason; readonly gate?: Gate; readonly approved?: true }
  | { readonly kind: 'escalation'; readonly status: 'waiting-on-you'; readonly gate: 'escalation' }
  | { readonly kind: 'pull-request' }
  | { readonly kind: 'record' }
  | { readonly kind: 'auto-plan' }

export const V1_KEY_MEANING = {
  ready: { kind: 'state', stage: 'plan', status: 'queued', reason: 'new' },
  planChangesRequested: { kind: 'state', stage: 'plan', status: 'queued', reason: 'changes-requested' },
  planning: { kind: 'state', stage: 'plan', status: 'running' },
  planReview: { kind: 'state', stage: 'plan', status: 'waiting-on-you', gate: 'plan-approval' },
  planApproved: { kind: 'state', stage: 'implement', status: 'queued', reason: 'new' },
  inProgress: { kind: 'state', stage: 'implement', status: 'running' },
  blocked: { kind: 'state', stage: 'implement', status: 'blocked' },
  readyForReview: { kind: 'state', stage: 'review', status: 'queued', reason: 'new' },
  reviewing: { kind: 'state', stage: 'review', status: 'running' },
  needsRevision: { kind: 'state', stage: 'revise', status: 'queued', reason: 'changes-requested' },
  revising: { kind: 'state', stage: 'revise', status: 'running' },
  refreshBranch: { kind: 'state', stage: 'refresh', status: 'queued', reason: 'new' },
  refreshing: { kind: 'state', stage: 'refresh', status: 'running' },
  approved: { kind: 'state', stage: 'merge', status: 'waiting-on-you', gate: 'merge', approved: true },
  needsHuman: { kind: 'escalation', status: 'waiting-on-you', gate: 'escalation' },
  prOpened: { kind: 'pull-request' },
  marker: { kind: 'record' },
  autoPlan: { kind: 'auto-plan' },
} as const satisfies Readonly<Record<LabelKey, V1KeyMeaning>>
