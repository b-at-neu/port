// Renderer-safe contract for the write chokepoint (#90): every mutation the
// app makes to GitHub is expressed in `LabelKey` values and a stated
// precondition, never a raw argv or a bypassing `gh` call. No import here
// may reach a Node builtin — `apps/desktop/src/main/writes/` is the only
// place that spawns `gh` or touches `.agents/cockpit.json` and
// `writes.jsonl`, but the renderer is this ticket's eventual consumer (#92),
// so this file compiles under `typecheck:web` too.
import type { LabelKey, LabelVocabulary } from '../labels/vocabulary'
import type { RepoId } from '../repos'

export type AssigneeExpectation = { readonly kind: 'any' } | { readonly kind: 'unassigned' } | { readonly kind: 'exactly'; readonly logins: readonly string[] }

/** Required, never defaulted (`present = remove`, `absent = add`) — a
 *  defaulted precondition is wrong for exactly the idempotent re-apply #94's
 *  resume performs, and a silently wrong precondition is worse than one the
 *  caller had to state (plan's own **Data & contracts**). */
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
  /** Where the scratch `--body-file` is written, and deleted from in a
   *  `finally` — argv-length limits on Windows, not shell quoting, are why
   *  the body never goes inline (`shell: false` means no shell string ever
   *  existed to quote). */
  readonly scratchDir: string
}

/** The state a precondition is evaluated against, and what a `Conflict` or
 *  audit entry's `observed` field carries. */
export interface ObservedItem {
  readonly labels: readonly string[]
  readonly assignees: readonly string[]
  readonly readAt: string
}

/** Mirrors `docs/COORDINATION.md` → "Detecting and presenting a conflict"
 *  verbatim — `scripts/checks/desktop-writes.mjs` pins the `kind` literals
 *  and field names against that fenced block, both directions, by literal
 *  and field-name set rather than byte-identity (the doc's fence omits the
 *  `readonly` modifiers this file's style requires). Only
 *  `precondition-failed` is *produced* by `main/writes/` — the other two
 *  arms belong to the reconciler (#79) and the UI (#92), and are pinned here
 *  so one definition exists rather than two partial ones. */
export type Conflict =
  | { readonly kind: 'precondition-failed'; readonly expected: readonly string[]; readonly observed: readonly string[]; readonly readAt: string }
  | { readonly kind: 'unattributed-transition'; readonly from: readonly string[]; readonly to: readonly string[]; readonly observedAt: string; readonly lastLocalWriteAt: string | null }
  | { readonly kind: 'dispatch-overtook-pause'; readonly agent: string; readonly pausedAt: string; readonly dispatchedAt: string }

/** Mirrors `main/dispatch/ownership.ts`'s own `OwnershipRead` — hand-maintained
 *  rather than an import, since the renderer cannot reach `main/`. Shared by
 *  the gate dialog (`shared/gate/types.ts`) and the dispatch owner line
 *  (`shared/dispatch/types.ts`), so both read the one shape. */
export type OwnershipSummary =
  | { readonly kind: 'absent' }
  | { readonly kind: 'app'; readonly since: string }
  | { readonly kind: 'terminal'; readonly since: string }
  | { readonly kind: 'unreadable'; readonly path: string; readonly message: string }

export type OwnershipKind = OwnershipSummary['kind']

/** Every failure kind a `gh …edit`/`…comment` call itself can report —
 *  hand-maintained rather than derived from `GhResult` (`main/platform/gh.ts`),
 *  for the same reason `PipelineFailureKind` (`shared/github/types.ts`) is.
 *  `main/writes/apply.ts` pins this against the real type with
 *  `AssertEqual`. */
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

/** The outcome table (plan's `## Data & contracts`). A successful outcome
 *  deliberately carries no resulting label set — `gh` exiting 0 is evidence
 *  the call landed, not a licence to synthesize state the app did not read,
 *  and a projected end state is precisely the "authoritative copy of stage
 *  state" #88's invariant forbids. The next poll reports what is there. */
export type WriteOutcome =
  | { readonly kind: 'applied'; readonly argv: readonly string[] }
  | { readonly kind: 'no-op' }
  | { readonly kind: 'precondition-failed'; readonly conflict: Conflict }
  /** A terminal cockpit owns this repo — no `gh` call was made. `since` is
   *  the ownership record's own clock, for the operator-facing "owned it
   *  since <time>" copy. */
  | { readonly kind: 'terminal-owned'; readonly since: string }
  /** `.agents/cockpit.json` could not be read — no `gh` call was made. */
  | { readonly kind: 'ownership-unreadable'; readonly path: string; readonly message: string }
  | { readonly kind: 'unresolvable-label'; readonly keys: readonly LabelKey[] }
  | { readonly kind: 'item-unavailable' }
  | { readonly kind: 'verify-failed'; readonly message: string }
  | { readonly kind: 'write-failed'; readonly classification: GhWriteFailureKind; readonly stderr: string; readonly reread: ObservedItem | null }

/** One line per attempt, `\n`-terminated JSON, written to
 *  `<app.getPath('userData')>/writes.jsonl` — one cross-repo file, outside
 *  every working tree (plan's own **The audit log**). `call` is the exact
 *  argv array that ran — never a reconstructed shell string, since
 *  `shell: false` means no shell string ever existed — and is `null` for
 *  every abort arm and for `no-op`, where no `gh` call was made. Writes and
 *  write attempts only; a read is never logged. */
export interface AuditEntry {
  readonly at: string
  readonly repo: string
  readonly repoId: RepoId
  readonly kind: 'issue' | 'pull-request'
  readonly number: number
  readonly action: string
  /** The ownership verdict this write read before touching anything — always
   *  populated now that ownership gates every write uniformly, never a
   *  `'not-required'` case the way the old claim scope had one. */
  readonly ownership: OwnershipKind
  readonly precondition: { readonly present: readonly string[]; readonly absent: readonly string[]; readonly assignees: AssigneeExpectation } | null
  readonly observed: ObservedItem | null
  readonly call: readonly string[] | null
  /** `postComment`'s own field — the comment is audited with its byte
   *  length and target, never its text. `null` on every label-write entry. */
  readonly commentBytes: number | null
  readonly result: WriteOutcome
}

export type AuditReadFailureKind = 'permission-denied' | 'too-large' | 'io'

export interface ReadAuditLogParams {
  readonly repo?: string
  readonly number?: number
  readonly limit?: number
}

/** A malformed line is counted, never silently dropped — the same
 *  discipline `main/local/denials.ts` applies to its own log.
 *  `previousPath` is set once `writes.prev.jsonl` exists from a rotation, so
 *  "older entries exist and are not shown" is stated rather than silent. */
export type AuditRead =
  | { readonly ok: true; readonly entries: readonly AuditEntry[]; readonly malformed: number; readonly previousPath: string | null; readonly readAt: string }
  | { readonly ok: false; readonly kind: AuditReadFailureKind; readonly message: string; readonly readAt: string }
