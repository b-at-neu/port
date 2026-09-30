// Renderer-safe search shapes (#87). No import here may reach a Node
// builtin or the Agent SDK — `main/search/` derives these from the same
// `TranscriptEntry[]` `main/sessions/` already parses, and the renderer is
// the eventual consumer over IPC, the same contract `shared/sessions/types.ts`
// already holds.
import type { RepoId } from '../repos'
import type { SessionFailureKind } from '../sessions/types'
import type { TranscriptEntry } from '../sessions/transcript'

export type SearchScope = { readonly kind: 'repo'; readonly repoId: RepoId } | { readonly kind: 'all' }

export interface SearchQuery {
  readonly query: string
  readonly scope: SearchScope
}

/** `text` for the three text-kind entries (user/assistant/thinking); `name`/
 *  `headline`/`input`/`result`/`diff` for a tool call; `label` for meta —
 *  `main/search/match.ts`'s `searchableFields` is the one place that derives
 *  this from a `TranscriptEntry`. */
export type SearchField = 'text' | 'name' | 'headline' | 'input' | 'result' | 'diff' | 'label'

/** A term shorter than the filter's own n-gram makes the trigram skip
 *  silently lossy — `scripts/checks/desktop-search.mjs` pins the two staying
 *  equal. */
export const MIN_TERM_CHARS = 3
export const TRIGRAM_SIZE = 3
export const SIGNATURE_HASHES = 2

/** Caps, all reported on `SearchResult`, never silently applied. */
export const MAX_HITS_PER_TRANSCRIPT = 20
export const MAX_TOTAL_HITS = 500
export const SCAN_BUDGET_MS = 4000

export interface SearchSnippet {
  readonly text: string
  readonly matchStart: number
  readonly matchLength: number
}

export interface SearchHit {
  readonly entryIndex: number
  readonly kind: TranscriptEntry['type']
  readonly toolName: string | null
  readonly field: SearchField
  readonly timestamp: string
  readonly snippet: SearchSnippet
}

export interface SearchGroup {
  readonly sessionId: string
  readonly agentId: string | null
  readonly repoId: RepoId | null
  readonly label: string
  readonly itemNumber: number | null
  readonly idleMs: number
  readonly hitCount: number
  readonly hits: readonly SearchHit[]
}

/**
 * Direction of failure: closed on the answer, open on reporting (same
 * contract as `TranscriptRead`/`SessionScan`). `unreached > 0` with
 * `complete: false` is the one partial case — it never renders as an empty
 * `groups`, which an operator would read as "nothing matched" rather than
 * "the time budget ran out". `sessions-unavailable` carries the underlying
 * `SessionScan` failure through rather than flattening it.
 */
export type SearchResult =
  | {
      readonly ok: true
      readonly groups: readonly SearchGroup[]
      readonly inScope: number
      readonly skippedByIndex: number
      readonly read: number
      readonly unreached: number
      readonly complete: boolean
      readonly hitsTruncated: boolean
      readonly indexPersisted: boolean
      readonly tookMs: number
    }
  | { readonly ok: false; readonly kind: 'invalid-query' }
  | { readonly ok: false; readonly kind: 'sessions-unavailable'; readonly sessionsKind: SessionFailureKind; readonly message: string }
