// Renderer-safe contract for the write chokepoint: every mutation the app makes to GitHub is expressed in `LabelKey` values and a stated precondition, never a raw argv or a bypassing `gh` call. No import here may reach a Node builtin.
import type { LabelKey, LabelVocabulary } from '../labels/vocabulary'
import type { RepoId } from '../repos'
import type { ReclaimerFailureKind } from '../reclaimer/types'

export type AssigneeExpectation = { readonly kind: 'any' } | { readonly kind: 'unassigned' } | { readonly kind: 'exactly'; readonly logins: readonly string[] }

/** Required, never defaulted (`present = remove`, `absent = add`) — a defaulted precondition would be silently wrong for the idempotent re-apply resume performs. */
export interface LabelPrecondition {
  readonly present: readonly LabelKey[]
  readonly absent: readonly LabelKey[]
  readonly assignees: AssigneeExpectation
}

export interface LabelWriteRequest {
  readonly repoId: RepoId
  readonly repo: string
  readonly kind: 'issue' | 'pull-request'
  readonly number: number
  readonly vocabulary: LabelVocabulary
  readonly add: readonly LabelKey[]
  readonly remove: readonly LabelKey[]
  readonly addAssignees: readonly string[]
  readonly removeAssignees: readonly string[]
  readonly expect: LabelPrecondition
  /** The operator-facing verb, recorded verbatim in the audit log. */
  readonly action: string
}

export interface CommentRequest {
  readonly repoId: RepoId
  readonly repo: string
  readonly kind: 'issue' | 'pull-request'
  readonly number: number
  readonly body: string
  readonly action: string
  /** Where the scratch `--body-file` is written, deleted from in a `finally` — argv-length limits on Windows, not shell quoting, are why the body never goes inline. */
  readonly scratchDir: string
}

/** The state a precondition is evaluated against, and what a `Conflict` or audit entry's `observed` field carries. */
export interface ObservedItem {
  readonly labels: readonly string[]
  readonly assignees: readonly string[]
  readonly readAt: string
}

/** Mirrors `docs/COORDINATION.md`'s conflict table, pinned both directions by literal and field-name set. Only `precondition-failed` is produced by `main/writes/` — the other two belong to the reconciler and the UI. */
export type Conflict =
  | { readonly kind: 'precondition-failed'; readonly expected: readonly string[]; readonly observed: readonly string[]; readonly readAt: string }
  | { readonly kind: 'unattributed-transition'; readonly from: readonly string[]; readonly to: readonly string[]; readonly observedAt: string; readonly lastLocalWriteAt: string | null }
  | { readonly kind: 'dispatch-overtook-pause'; readonly agent: string; readonly pausedAt: string; readonly dispatchedAt: string }

/** Mirrors `main/dispatch/ownership.ts`'s own `OwnershipRead`, hand-maintained since the renderer cannot reach `main/`. Shared by the gate dialog and the dispatch owner line. */
export type OwnershipSummary =
  | { readonly kind: 'absent' }
  | { readonly kind: 'app'; readonly since: string }
  | { readonly kind: 'terminal'; readonly since: string }
  | { readonly kind: 'unreadable'; readonly path: string; readonly message: string }

export type OwnershipKind = OwnershipSummary['kind']

/** Every failure kind a `gh …edit`/`…comment` call itself can report — hand-maintained, pinned against the real type with `AssertEqual`. */
export type GhWriteFailureKind =
  | 'not-found'
  | 'cwd-missing'
  | 'signalled'
  | 'timeout'
  | 'output-too-large'
  | 'spawn-failed'
  | 'unauthenticated'
  | 'rate-limited'
  | 'forbidden'
  | 'http-not-found'
  | 'network'
  | 'unknown'

/** The outcome table. A successful outcome deliberately carries no resulting label set — `gh` exiting 0 is evidence the call landed, not a licence to synthesize state the app did not read. */
export type WriteOutcome =
  | { readonly kind: 'applied'; readonly argv: readonly string[] }
  | { readonly kind: 'no-op' }
  | { readonly kind: 'precondition-failed'; readonly conflict: Conflict }
  /** A terminal cockpit owns this repo — no `gh` call was made. `since` feeds the operator-facing "owned it since <time>" copy. */
  | { readonly kind: 'terminal-owned'; readonly since: string }
  /** `.agents/cockpit.json` could not be read — no `gh` call was made. */
  | { readonly kind: 'ownership-unreadable'; readonly path: string; readonly message: string }
  | { readonly kind: 'unresolvable-label'; readonly keys: readonly LabelKey[] }
  | { readonly kind: 'item-unavailable' }
  | { readonly kind: 'verify-failed'; readonly message: string }
  | { readonly kind: 'write-failed'; readonly classification: GhWriteFailureKind; readonly stderr: string; readonly reread: ObservedItem | null }

/** One line per attempt, `\n`-terminated JSON, in `writes.jsonl`. `call` is the exact argv that ran, or `null` for an abort/no-op arm.
 *  Writes and write attempts only; a read is never logged. */
export interface LabelAuditEntry {
  readonly at: string
  readonly repo: string
  readonly repoId: RepoId
  readonly kind: 'issue' | 'pull-request'
  readonly number: number
  readonly action: string
  /** The ownership verdict this write read before touching anything — always populated now that ownership gates every write uniformly. */
  readonly ownership: OwnershipKind
  readonly precondition: { readonly present: readonly string[]; readonly absent: readonly string[]; readonly assignees: AssigneeExpectation } | null
  readonly observed: ObservedItem | null
  readonly call: readonly string[] | null
  /** `postComment`'s own field — the comment is audited with its byte length and target, never its text. `null` on every label-write entry. */
  readonly commentBytes: number | null
  readonly result: WriteOutcome
}

// The worktree-reclaim arm — `removed`/`failed` are each candidate's own
// `pathBasename`, never a raw path. `failure` is set only when `result` is `'failed'`.
export interface ReclaimAuditEntry {
  readonly at: string
  readonly repo: string
  readonly repoId: RepoId
  readonly action: 'worktree-reclaim'
  readonly issue: number | null
  readonly call: readonly string[] | null
  readonly removed: readonly string[]
  readonly failed: readonly string[]
  readonly result: 'applied' | 'partial' | 'failed'
  readonly failure: ReclaimerFailureKind | null
}

export type AuditEntry = LabelAuditEntry | ReclaimAuditEntry

// `'worktree-reclaim'` is the one `action` value `LabelAuditEntry` never takes.
export function isLabelAuditEntry(entry: AuditEntry): entry is LabelAuditEntry {
  return entry.action !== 'worktree-reclaim'
}

export type AuditReadFailureKind = 'permission-denied' | 'too-large' | 'io'

export interface ReadAuditLogParams {
  readonly repo?: string
  readonly number?: number
  readonly limit?: number
}

/** A malformed line is counted, never silently dropped. `previousPath` is set once a rotation exists, so "older entries exist and are not shown" is stated rather than silent. */
export type AuditRead =
  | { readonly ok: true; readonly entries: readonly AuditEntry[]; readonly malformed: number; readonly previousPath: string | null; readonly readAt: string }
  | { readonly ok: false; readonly kind: AuditReadFailureKind; readonly message: string; readonly readAt: string }
