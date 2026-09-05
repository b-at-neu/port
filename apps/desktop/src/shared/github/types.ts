// Renderer-safe result and item shapes for the GitHub adapter (#76). No
// import here may reach a Node builtin — apps/desktop/src/main/github/ is
// the only place that spawns `gh`, but the renderer is the eventual consumer
// of these shapes over IPC (#79/#80), so this file compiles under
// `typecheck:web` too.
import type { LabelKey, LabelSource, VocabularyReport } from '../labels/vocabulary'

export type PipelineItemKind = 'issue' | 'pull-request'

/** The field list is exactly the ticket's, plus `matchedKeys`. `mergeable`,
 *  `headRefOid`, `updatedAt`, and the viewer's login are deliberately absent
 *  — each belongs to a later ticket that has a use for it (ENGINEERING §7:
 *  no field shipped in anticipation). */
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
