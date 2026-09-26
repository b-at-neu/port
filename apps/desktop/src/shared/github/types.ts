// Renderer-safe result and item shapes for the GitHub adapter (#76). No
// import here may reach a Node builtin — apps/desktop/src/main/github/ is
// the only place that spawns `gh`, but the renderer is the eventual consumer
// of these shapes over IPC (#79/#80), so this file compiles under
// `typecheck:web` too.
import type { LabelKey, LabelSource, VocabularyReport } from '../labels/vocabulary'

export type PipelineItemKind = 'issue' | 'pull-request'

/** The field list is exactly the ticket's, plus `matchedKeys`. `mergeable`,
 *  `headRefOid`, and `updatedAt` are deliberately absent — each belongs to a
 *  later ticket that has a use for it (ENGINEERING §7: no field shipped in
 *  anticipation). The viewer's own login is no longer absent: #94 needs it
 *  at the repository level (see `PipelineFetch.viewer` below), one alias
 *  reused for every item rather than a per-item field. */
export interface PipelineItem {
  readonly repo: string
  readonly kind: PipelineItemKind
  readonly number: number
  readonly title: string
  readonly url: string
  readonly body: string
  readonly state: string
  readonly mergedAt: string | null
  readonly assignees: readonly string[]
  readonly labels: readonly string[]
  readonly matchedKeys: readonly LabelKey[]
}

/** One entry per enabled label — the names actually queried, reported
 *  beside the results so an empty `items` is attributable rather than
 *  ambiguous with a wrong query. */
export interface QueriedLabel {
  readonly key: LabelKey
  readonly name: string
  readonly source: LabelSource
  readonly issueAlias: string
  readonly prAlias: string
}

/** One entry per alias named in a partial response's `errors[].path`. An
 *  unavailable alias is never read as empty — its label is listed here and
 *  excluded from any "nothing at this stage" claim. */
export interface UnavailableAlias {
  readonly alias: string
  readonly key: LabelKey
  readonly surface: PipelineItemKind
  readonly name: string
}

/** One entry per connection whose `totalCount` exceeds its `nodes` length.
 *  Deliberately not paginated — see the plan's `## Risks / notes`. */
export interface TruncatedSet {
  readonly alias: string
  readonly key: LabelKey
  readonly surface: PipelineItemKind
  readonly totalCount: number
  readonly received: number
}

export interface RateLimitInfo {
  readonly cost: number
  readonly remaining: number
  readonly resetAt: string
}

export interface ItemRef {
  readonly kind: PipelineItemKind
  readonly number: number
}

/** `fetchItemStates`'s per-item result — the only reason `state`/`mergedAt`
 *  are meaningful fields at all: the open-only sweep above cannot see a
 *  merged pull request, and this is the primitive that re-checks. */
export interface ItemState {
  readonly kind: PipelineItemKind
  readonly number: number
  readonly state: string
  readonly mergedAt: string | null
  readonly closedAt: string | null
  readonly url: string
}

/**
 * Every failure kind `fetchPipelineItems`/`fetchItemStates` can report — a
 * flat literal union, hand-maintained rather than derived from `GhResult`
 * (the renderer cannot import `main/platform/gh.ts`, which reaches a Node
 * subprocess builtin). `main/github/adapter.ts`'s `_kindsCoverGhResult`
 * assertion pins this against the real platform-layer type, so a new
 * failure kind introduced there breaks `pnpm typecheck` here instead of
 * silently landing in the `unknown` bucket.
 */
export type PipelineFailureKind =
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
  | 'unparseable'
  | 'no-data'
  | 'repo-not-found'

/**
 * Everything fails **closed on the answer, open on reporting**: no path
 * below returns `items: []` for a request that did not actually succeed. The
 * single exception is a partial response, which returns `ok: true` **with**
 * the missing aliases named in `unavailable` — dropping the aliases that did
 * work would be discarding good data to punish a bad one.
 */
export type PipelineFetch =
  | {
      readonly ok: true
      readonly items: readonly PipelineItem[]
      readonly queried: readonly QueriedLabel[]
      readonly disabled: readonly LabelKey[]
      readonly vocabulary: VocabularyReport
      readonly unavailable: readonly UnavailableAlias[]
      readonly truncated: readonly TruncatedSet[]
      readonly rateLimit: RateLimitInfo
      /** The signed-in account's own login (#94's ownership check) — `null`,
       *  never a guess, when the top-level `viewer` alias is absent or a
       *  partial response dropped it. Unlike `fetchClaimPreflight`, an
       *  unresolvable viewer never fails this whole fetch: the board still
       *  has every label fact to show, only the per-row action strip loses
       *  its ownership answer. */
      readonly viewer: string | null
      readonly fetchedAt: string
    }
  | {
      readonly ok: false
      readonly kind: PipelineFailureKind
      readonly message: string
      readonly fetchedAt: string
    }

/** `fetchItemsByNumber`'s per-number result (#79 Decision 4) — `kind` comes
 *  from the response's own `__typename`, never assumed, since a worktree or
 *  an agent record names a bare number with no kind attached. `assignees`
 *  (#90) is the second fact the write chokepoint's authoritative read needs
 *  beside `labels` — one round trip covers both. */
export interface ResolvedItem {
  readonly number: number
  readonly kind: PipelineItemKind
  readonly state: string
  readonly mergedAt: string | null
  readonly closedAt: string | null
  readonly title: string
  readonly url: string
  readonly labels: readonly string[]
  readonly assignees: readonly string[]
}

/** `fetchItemsByNumber`'s result — a number resolving to neither an issue
 *  nor a pull request lands in `unavailable`, never inferred as any
 *  particular state. */
export type ItemsByNumberFetch =
  | {
      readonly ok: true
      readonly resolved: readonly ResolvedItem[]
      readonly unavailable: readonly number[]
      readonly fetchedAt: string
    }
  | {
      readonly ok: false
      readonly kind: PipelineFailureKind
      readonly message: string
      readonly fetchedAt: string
    }

/** `fetchItemStates`'s result — a vanished number is reported in
 *  `unavailable`, never inferred as "still open" (#79's own rule). */
export type ItemStatesFetch =
  | {
      readonly ok: true
      readonly states: readonly ItemState[]
      readonly unavailable: readonly ItemRef[]
      readonly fetchedAt: string
    }
  | {
      readonly ok: false
      readonly kind: PipelineFailureKind
      readonly message: string
      readonly fetchedAt: string
    }

/** One open-or-closed node off a `blockedBy` connection (#93) — the claim
 *  dialog reports every one it fetched, and `classifyPreflight` filters to
 *  the open ones itself, so `main/github/adapter.ts` never decides what
 *  counts as "still blocking". */
export interface ClaimBlocker {
  readonly number: number
  readonly title: string
  readonly url: string
  readonly state: string
}

/** A `blockedBy` read that failed is a distinct value, never an empty list —
 *  "no blockers" and "couldn't tell" must not collapse into one state
 *  (ENGINEERING §4: an absent signal is never read as a passing one).
 *  `shown`/`total` differing is the connection's own truncation signal, the
 *  same shape `TruncatedSet` already uses elsewhere in this file. */
export type BlockerRead =
  | { readonly ok: true; readonly open: readonly ClaimBlocker[]; readonly shown: number; readonly total: number }
  | { readonly ok: false; readonly reason: string }

/** `fetchClaimPreflight`'s resolved node — a pull request carries only its
 *  identity fields, since `classifyPreflight` refuses it (`not-an-issue`)
 *  before `labels`/`assignees`/`blockers` would ever matter, and the query
 *  never requests them on that branch (#93 Decision, `query.ts`). */
export interface ClaimPreflightItem {
  readonly kind: PipelineItemKind
  readonly number: number
  readonly title: string
  readonly url: string
  readonly state: string
  readonly labels: readonly string[]
  readonly assignees: readonly string[]
  readonly blockers: BlockerRead
}

/** `fetchClaimPreflight`'s result. `item: null` covers both "the number does
 *  not exist" and "the alias itself errored" — neither is a failure, since a
 *  typo'd number is an ordinary outcome of the operator typing one in. An
 *  unresolvable `viewer.login` is the one thing that *does* fail the whole
 *  preflight (`ok: false`, kind `no-data`): the take-over decision cannot be
 *  made without knowing who "me" is. */
export type ClaimPreflightFetch =
  | { readonly ok: true; readonly item: ClaimPreflightItem | null; readonly viewer: string; readonly fetchedAt: string }
  | { readonly ok: false; readonly kind: PipelineFailureKind; readonly message: string; readonly fetchedAt: string }

/** `fetchGatePreflight`'s resolved node (#92) — a pull request carries only
 *  its identity fields, since `classifyGate` refuses it (`not-an-issue`)
 *  before `body`/`labels`/`assignees` would ever matter, and the query never
 *  requests them on that branch (`main/github/query.ts`'s own
 *  `buildGatePreflightQuery`). `body` is the raw issue body, unsplit —
 *  `main/actions/gate.ts` is where it is divided at
 *  `IMPLEMENTATION_PLAN_HEADING`, never this adapter. */
export interface GatePreflightItem {
  readonly kind: PipelineItemKind
  readonly number: number
  readonly title: string
  readonly url: string
  readonly state: string
  readonly body: string
  readonly labels: readonly string[]
  readonly assignees: readonly string[]
}

/** `fetchGatePreflight`'s result. `item: null` covers both "the number does
 *  not exist" and "the alias itself errored" — neither is a failure, the
 *  same rule `ClaimPreflightFetch` follows. An unresolvable `viewer.login` is
 *  the one thing that fails the whole preflight (`ok: false`, kind
 *  `no-data`) — the assignee note and the `answerable` verdict's own
 *  ownership context cannot be rendered without knowing who "me" is. */
export type GatePreflightFetch =
  | { readonly ok: true; readonly item: GatePreflightItem | null; readonly viewer: string; readonly fetchedAt: string }
  | { readonly ok: false; readonly kind: PipelineFailureKind; readonly message: string; readonly fetchedAt: string }
