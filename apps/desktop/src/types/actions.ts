import type { BoardSnapshot } from '@/types/board'
import type { RegistryDeps } from '@/types/registry'
import type { GateDecision } from '@/types/gate'
import type { ReconciledItem } from '@/types/state'
import type { WriteObservation } from '@/types/dispatch'
import type { AuditRead } from '@/types/writes'
import type { RepositoryEntry, RepoId } from '@/utils/repos'
import type { LabelVocabulary } from '@/utils/labels/vocabulary'

// Renderer-safe contract for the single-label operator actions: pause, resume, retry, stop, gate. No import here may reach a Node builtin.
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { LabelPrecondition, WriteOutcome } from '@/types/writes'

/** Recorded verbatim as `AuditEntry.action`; `refresh` needs no comment or operator choice, so it stays out of `OperatorDecision` below. */
export const OPERATOR_ACTIONS = ['pause', 'resume', 'retry', 'stop', 'gate', 'refresh'] as const
export type OperatorAction = (typeof OPERATOR_ACTIONS)[number]

/** The two actions that need a comment and, for unblock, an operator choice of route. */
export const OPERATOR_DECISIONS = ['unblock', 'revise'] as const
export type OperatorDecision = (typeof OPERATOR_DECISIONS)[number]

/** Unblock's own fork — which trigger the cleared item goes back to. */
export const UNBLOCK_ROUTES = ['revision', 'review'] as const
export type UnblockRoute = (typeof UNBLOCK_ROUTES)[number]

export interface ItemActionRequest {
  readonly repoId: RepoId
  readonly kind: 'issue' | 'pull-request'
  readonly number: number
  readonly action: OperatorAction
  /** `null` when the row showed no stage (resume). A mismatch against a fresh read refuses. */
  readonly expectedStage: LabelKey | null
}

/** One option of a rebase decision, as the escalation's options table lists it. */
export interface RebaseOption {
  readonly letter: string
  readonly label: string
}

/** One `### D<n>` block of a rebase escalation; `recommended` is `null` when the block names none. */
export interface RebaseDecision {
  readonly id: string
  readonly path: string
  readonly summary: string | null
  readonly options: readonly RebaseOption[]
  readonly recommended: string | null
}

/** The operator's chosen option for one decision; main re-derives the path and label from its own parse. */
export interface RebasePick {
  readonly id: string
  readonly letter: string
}

export interface ItemDecisionRequest {
  readonly repoId: RepoId
  readonly number: number
  readonly decision: OperatorDecision
  readonly expectedStage: LabelKey | null
  readonly route: UnblockRoute | null
  readonly note: string | null
  readonly skipComment: boolean
  /** `null` unless the escalation carries rebase decisions. */
  readonly picks: readonly RebasePick[] | null
}

/** The `LabelWriteRequest` key-level shape; the main side supplies the rest from the registry entry, never from a plan a caller could forge. */
export interface ActionPlan {
  readonly add: readonly LabelKey[]
  readonly remove: readonly LabelKey[]
  readonly addAssignees: readonly string[]
  readonly removeAssignees: readonly string[]
  readonly expect: LabelPrecondition
  /** Forwarded to `LabelWriteRequest.action` unchanged. */
  readonly action: string
}

/** Why an action is unavailable: `not-applicable` is a role/marker mismatch; `not-owned` and `viewer-unknown` are ownership refusals applied ahead of every plan. */
export type ActionRefusal = 'not-applicable' | 'not-owned' | 'viewer-unknown'

export type ActionAvailability = { readonly available: true; readonly plan: ActionPlan } | { readonly available: false; readonly reason: ActionRefusal }

/** `'item:action'`'s response. Every `ok: false` arm is a refusal reached before `applyLabels` is called; `moved` is a stale renderer view, not the write-time race `precondition-failed` covers. */
export type ItemActionResult =
  | { readonly ok: true; readonly outcome: WriteOutcome }
  | { readonly ok: false; readonly reason: 'moved'; readonly expected: string; readonly observed: string }
  | { readonly ok: false; readonly reason: 'not-owned'; readonly owners: readonly string[] }
  | { readonly ok: false; readonly reason: 'viewer-unknown' }
  | { readonly ok: false; readonly reason: 'repo-unavailable' }
  | { readonly ok: false; readonly reason: 'no-pause-record' }
  | { readonly ok: false; readonly reason: 'pause-record-unresolvable' }

/** `cycle-cap`: revise would only escalate straight back. `rebase-decisions`: an escalation whose decision blocks port can't parse. */
export type DecisionRefusal = ActionRefusal | 'cycle-cap' | 'rebase-decisions'

/** `null` when no escalation reason was found; the dialog shows the cap warning before a route is picked. `decisions` is empty for a non-rebase escalation. */
export interface UnblockContext {
  readonly reason: string | null
  readonly cyclesUsed: number
  readonly cap: number
  readonly decisions: readonly RebaseDecision[]
}

export interface ReviseContext {
  readonly headRefOid: string
  readonly cyclesUsed: number
  readonly cap: number
}

export type DecisionAvailability =
  | { readonly available: true; readonly context: UnblockContext | ReviseContext }
  | { readonly available: false; readonly reason: DecisionRefusal }

/** Same shape family as `ItemActionResult`, with `comment`/`labels` replacing `outcome` since a decision writes both. */
export type ItemDecisionResult =
  | { readonly ok: true; readonly comment: WriteOutcome | null; readonly labels: WriteOutcome }
  | { readonly ok: false; readonly reason: 'moved'; readonly expected: string; readonly observed: string }
  | { readonly ok: false; readonly reason: 'not-owned'; readonly owners: readonly string[] }
  | { readonly ok: false; readonly reason: 'viewer-unknown' }
  | { readonly ok: false; readonly reason: 'repo-unavailable' }
  | { readonly ok: false; readonly reason: 'refused'; readonly refusal: DecisionRefusal | 'note-invalid' | 'picks-invalid'; readonly problem?: string }
  | { readonly ok: false; readonly reason: 'verify-failed'; readonly message: string }
  | { readonly ok: false; readonly reason: 'comment-failed'; readonly comment: WriteOutcome }

/** `reviseNoteProblem` refuses anything longer, before a single byte reaches `gh`. */
export const MAX_REVISE_NOTE_CHARS = 10_000

export interface ApplyItemActionParams {
  readonly request: ItemActionRequest
  readonly snapshot: BoardSnapshot
  readonly entry: ReadyEntry
  readonly auditDir: string
}

export type ReadyEntry = Extract<RepositoryEntry, { readonly status: 'ready' }>

export interface ApplyItemDecisionParams {
  readonly request: ItemDecisionRequest
  readonly snapshot: BoardSnapshot
  readonly entry: ReadyEntry
  readonly auditDir: string
  readonly scratchDir: string
}

export interface EscalateToHumanResult {
  readonly labels: WriteOutcome
  /** `null` when the label swap did not reach `applied` — no comment is attempted then. */
  readonly comment: WriteOutcome | null
}

export interface EscalateToHumanParams {
  readonly entry: ReadyEntry
  readonly kind: 'issue' | 'pull-request'
  readonly number: number
  readonly trigger: LabelKey
  readonly viewer: string
  readonly body: string
  readonly action: string
  readonly auditDir: string
  readonly scratchDir: string
}

export interface AutoApprovePlanParams {
  readonly entry: ReadyEntry
  readonly item: { readonly number: number; readonly assignees: readonly string[] }
  readonly auditDir: string
}

export interface GateAnswerParams {
  readonly registryDeps: RegistryDeps
  readonly repoId: RepoId
  readonly number: number
  readonly decision: GateDecision
  readonly feedback: string | null
  /** A renderer-supplied `skipComment` can only ever suppress the comment write, never widen it. */
  readonly skipComment: boolean
  readonly auditDir: string
  readonly scratchDir: string
}

export interface GatePreflightParams {
  readonly registryDeps: RegistryDeps
  readonly repoId: RepoId
  readonly number: number
}

export interface ApplyObservationResult {
  readonly labels: WriteOutcome
  /** `null` when the label swap did not reach `applied`, or the plan carried no comment. */
  readonly comment: WriteOutcome | null
}

export interface ApplyObservationParams {
  readonly entry: ReadyEntry
  readonly item: ReconciledItem
  readonly observation: WriteObservation
  readonly auditDir: string
  readonly scratchDir: string
}

export interface RecoverPausedTriggerParams {
  readonly auditDir: string
  readonly repo: string
  readonly number: number
  readonly vocabulary: LabelVocabulary
  readonly readAuditLog?: (dir: string, params: { readonly repo?: string; readonly number?: number }) => Promise<AuditRead>
}

export type RecoverPausedTriggerResult = { readonly kind: 'recovered'; readonly trigger: LabelKey } | { readonly kind: 'no-record' } | { readonly kind: 'unresolvable' }
