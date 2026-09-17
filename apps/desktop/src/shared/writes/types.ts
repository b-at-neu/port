// Renderer-safe contract for the write chokepoint (#90): every mutation the
// app makes to GitHub is expressed in `LabelKey` values and a stated
// precondition, never a raw argv or a bypassing `gh` call. No import here
// may reach a Node builtin — `apps/desktop/src/main/writes/` is the only
// place that spawns `gh` or touches `.agents/gate-claim.json` and
// `writes.jsonl`, but the renderer is this ticket's eventual consumer (#92),
// so this file compiles under `typecheck:web` too.
import type { LabelKey, LabelVocabulary } from '../labels/vocabulary'
import type { RepoId } from '../repos'

/** One recognized claim scope today — `docs/COORDINATION.md`'s own rule
 *  ("one scope, not a framework"): the array shape is the natural fit for
 *  the question, but no second scope is defined that no ticket implements. */
export type ClaimScope = 'plan-gate'

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

/** A held claim's own fields — `owner` is free text for the cockpit's
 *  report only and is never read as liveness (a pid, port, or heartbeat);
 *  `unknownScopes` carries anything `scopes` held that this app does not
 *  recognize, rather than silently dropping it (`docs/COORDINATION.md` →
 *  "The claim contract"). */
export interface HeldClaim {
  readonly owner: string
  readonly scopes: readonly ClaimScope[]
  readonly unknownScopes: readonly string[]
  readonly claimedAt: string
}

/** A `repo` mismatch reads as `absent` — a positive determination, never
 *  ambiguity, the same rule `.temp/tick-state.md`'s `Repo` header already
 *  follows. Malformed or unreadable JSON reads as `unreadable`, on both
 *  sides of the claim standing down (`docs/COORDINATION.md` → "Failure
 *  directions"). */
export type ClaimRead =
  | ({ readonly state: 'held'; readonly path: string; readonly readAt: string } & HeldClaim)
  | { readonly state: 'absent'; readonly path: string; readonly readAt: string }
  | { readonly state: 'unreadable'; readonly message: string; readonly path: string; readonly readAt: string }

/** Every failure kind a claim-file write (`takeGateClaim`/`releaseGateClaim`)
 *  can report — hand-maintained rather than derived from the platform
 *  layer's `FileFailureKind` (`main/platform/files.ts`), for the same reason
 *  every other shared failure union here is: the renderer cannot import
 *  `main/platform/`. `main/writes/claim.ts` pins this against the real type
 *  with `AssertEqual`. */
export type ClaimWriteFailureKind = 'not-found' | 'not-a-file' | 'permission-denied' | 'too-large' | 'io'

export type ClaimWriteResult = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly kind: ClaimWriteFailureKind; readonly message: string; readonly path: string }

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
  /** `keys` is the request's own `[...remove, ...add]` (first hit wins), so a
   *  caller whose real label — resume's recovered trigger — is only known
   *  server-side, after the request was built, can still name it exactly
   *  rather than falling back to generic copy (#94 review). */
  | { readonly kind: 'unclaimed-scope'; readonly scope: ClaimScope; readonly claimPath: string; readonly keys: readonly LabelKey[] }
  | { readonly kind: 'claim-unreadable'; readonly scope: ClaimScope; readonly claimPath: string; readonly message: string }
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
  readonly scope: ClaimScope | null
  readonly claim: 'absent' | 'held' | 'unreadable' | 'not-required'
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
