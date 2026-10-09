// Renderer-safe result and item shapes for the GitHub adapter. No import here may reach a Node builtin — only `main/github/` spawns `gh`.
import type { LabelKey, LabelSource, VocabularyReport } from '../labels/vocabulary'

export type PipelineItemKind = 'issue' | 'pull-request'

/** One `reviews` connection node — `commitOid` is flattened at read time so nothing under `main/tick/` ever reaches into a nested GraphQL shape. */
export interface ReviewNode {
  readonly body: string
  readonly submittedAt: string
  readonly commitOid: string | null
}

/** One `comments` connection node — the `## Gate cleared` carve-out's own evidence, alongside `reviews`. */
export interface PullRequestCommentNode {
  readonly body: string
  readonly createdAt: string
}

/** GitHub's own mergeability enum, mapped verbatim — `null` for an issue. `UNKNOWN` never blocks the caller: reading it is what triggers GitHub to compute it. */
export type Mergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null

/** One reduced `statusCheckRollup` context — a CheckRun or a StatusContext, flattened to the shape `rollupVerdict` reads. Timestamps stay distinct since `reduceRollup` needs all three to pick the latest entry per name. */
export interface CheckContext {
  readonly __typename: 'CheckRun' | 'StatusContext' | null
  readonly name: string | null
  readonly conclusion: string | null
  readonly status: string | null
  readonly state: string | null
  readonly startedAt: string | null
  readonly completedAt: string | null
  readonly createdAt: string | null
  /** A CheckRun's `detailsUrl` or a StatusContext's `targetUrl` — never read by `rollupVerdict`, only by the approval-withdrawal observation's own comment link. */
  readonly url: string | null
}

/** `headRefOid`/`mergeable`/`reviews`/`comments` are `null` for an issue — only a pull request carries any of the four. */
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
  readonly headRefOid: string | null
  readonly mergeable: Mergeable
  readonly reviews: readonly ReviewNode[] | null
  readonly comments: readonly PullRequestCommentNode[] | null
  /** The `approved` alias's own `statusCheckRollup` selection — `null` means this alias did not select it; `[]` means it was selected but GitHub returned no rollup at all. */
  readonly checkRollup: readonly CheckContext[] | null
}

/** One entry per enabled label, reported beside the results so an empty `items` is attributable rather than ambiguous with a wrong query. */
export interface QueriedLabel {
  readonly key: LabelKey
  readonly name: string
  readonly source: LabelSource
  readonly issueAlias: string
  readonly prAlias: string
}

/** One entry per alias named in a partial response's `errors[].path`. Never read as empty — excluded from any "nothing at this stage" claim. */
export interface UnavailableAlias {
  readonly alias: string
  readonly key: LabelKey
  readonly surface: PipelineItemKind
  readonly name: string
}

/** One entry per connection whose `totalCount` exceeds its `nodes` length. Deliberately not paginated. */
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

/** `fetchItemStates`'s per-item result — the open-only sweep above cannot see a merged pull request, and this is the primitive that re-checks. */
export interface ItemState {
  readonly kind: PipelineItemKind
  readonly number: number
  readonly state: string
  readonly mergedAt: string | null
  readonly closedAt: string | null
  readonly url: string
}

/** Every failure kind these fetches can report — hand-maintained, pinned against the real platform-layer type so a new kind there breaks `pnpm typecheck` here rather than landing in `unknown`. */
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

/** Fails closed on the answer, open on reporting: no path returns `items: []` for a request that did not succeed. A partial response is `ok: true` with missing aliases named in `unavailable`. */
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
      /** The signed-in account's own login — `null`, never a guess, when absent or dropped. Unlike `fetchClaimPreflight`, an unresolvable viewer never fails this whole fetch. */
      readonly viewer: string | null
      readonly fetchedAt: string
    }
  | {
      readonly ok: false
      readonly kind: PipelineFailureKind
      readonly message: string
      readonly fetchedAt: string
    }

/** `fetchItemsByNumber`'s per-number result — `kind` comes from the response's own `__typename`, never assumed. `assignees` is the second fact the write chokepoint needs beside `labels`; one round trip covers both. */
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

/** `fetchItemsByNumber`'s result — a number resolving to neither an issue nor a pull request lands in `unavailable`, never inferred as any particular state. */
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

/** `fetchItemStates`'s result — a vanished number is reported in `unavailable`, never inferred as "still open". */
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

/** One open-or-closed node off a `blockedBy` connection — the claim dialog reports every one it fetched; `classifyPreflight` filters to the open ones, so the adapter never decides what counts as "still blocking". */
export interface ClaimBlocker {
  readonly number: number
  readonly title: string
  readonly url: string
  readonly state: string
}

/** A `blockedBy` read that failed is a distinct value, never an empty list — "no blockers" and "couldn't tell" must not collapse into one state. `shown`/`total` differing is the connection's own truncation signal. */
export type BlockerRead =
  | { readonly ok: true; readonly open: readonly ClaimBlocker[]; readonly shown: number; readonly total: number }
  | { readonly ok: false; readonly reason: string }

/** `fetchClaimPreflight`'s resolved node — a pull request carries only its identity fields, since `classifyPreflight` refuses it before `labels`/`assignees`/`blockers` would ever matter. */
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

/** `fetchClaimPreflight`'s result. `item: null` covers both "doesn't exist" and "alias errored" — neither is a failure. An unresolvable `viewer.login` does fail the whole preflight: the take-over decision needs to know who "me" is. */
export type ClaimPreflightFetch =
  | { readonly ok: true; readonly item: ClaimPreflightItem | null; readonly viewer: string; readonly fetchedAt: string }
  | { readonly ok: false; readonly kind: PipelineFailureKind; readonly message: string; readonly fetchedAt: string }

/** `fetchGatePreflight`'s resolved node — a pull request carries only its identity fields, since `classifyGate` refuses it first. `body` is the raw issue body, unsplit — `main/actions/gate.ts` divides it, never this adapter. */
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

/** `fetchGatePreflight`'s result. `item: null` covers both "doesn't exist" and "alias errored", same rule as `ClaimPreflightFetch`. An unresolvable `viewer.login` fails the whole preflight. */
export type GatePreflightFetch =
  | { readonly ok: true; readonly item: GatePreflightItem | null; readonly viewer: string; readonly fetchedAt: string }
  | { readonly ok: false; readonly kind: PipelineFailureKind; readonly message: string; readonly fetchedAt: string }
