// The per-source cache (#80 Decision 3/4) — one refresh primitive per
// source, each keeping the previous good value in place on a failed
// attempt. `watcher.ts` decides *when* to call these; `read.ts`'s
// `projectFromCache` is the only reader of what they leave behind. No file
// here names a timer.
import { fetchItemsByNumber, fetchPipelineItems } from '../github'
import type { GhRunner } from '../github'
import { collectOrphanNumbers } from './attach'
import { readDenials, readWorktrees } from '../local'
import type { WorktreesGitRunner as GitRunner } from '../local'
import { readSessionState } from '../sessions'
import type { RepoId } from '../../shared/repos'
import type { LabelVocabulary } from '../../shared/labels/vocabulary'
import type { DenialsRead, WorktreeEntry, WorktreesRead } from '../../shared/local/types'
import type { AgentRecord, SessionScan } from '../../shared/sessions/types'
import type { ItemsByNumberFetch, PipelineFailureKind, PipelineFetch, RateLimitInfo } from '../../shared/github/types'

export interface SourceCache {
  readonly github: Map<RepoId, PipelineFetch>
  /** The GitHub primitive's own conditional re-check result — keyed with
   *  the fetch it belongs to, never independently schedulable (`SOURCE_KINDS`
   *  deliberately excludes `itemStates`). */
  readonly itemStates: Map<RepoId, ItemsByNumberFetch | null>
  readonly worktrees: Map<RepoId, WorktreesRead>
  readonly denials: Map<RepoId, DenialsRead>
  /** One machine-wide scan (#78 Decision 1) — never per repository. */
  sessions: SessionScan | null
}

export function createSourceCache(): SourceCache {
  return { github: new Map(), itemStates: new Map(), worktrees: new Map(), denials: new Map(), sessions: null }
}

/** What every refresh primitive reports back to the caller for health
 *  bookkeeping — `schedule.ts`'s `afterSuccess`/`afterFailure` read this,
 *  never the cache directly. */
export interface RefreshOutcome {
  readonly ok: boolean
  readonly at: string
  readonly error?: string
  /** GitHub-only — the window this attempt read, regardless of whether the
   *  attempt itself succeeded, so `schedule.ts`'s `deferredUntil` can defer
   *  even a successful-but-low-headroom read (Decision 4). */
  readonly rateLimit?: RateLimitInfo | null
  /** GitHub-only — the raw failure kind, so a `rate-limited` failure can
   *  defer to `resetAt` rather than double the interval like any other
   *  failure. */
  readonly failureKind?: PipelineFailureKind | null
}

function projectOk<T extends { readonly ok: boolean }>(previous: T | null, attempt: T): T {
  return attempt.ok ? attempt : (previous ?? attempt)
}

export interface RefreshGithubParams {
  readonly repoId: RepoId
  readonly repo: { readonly owner: string; readonly name: string }
  readonly vocabulary: LabelVocabulary
  /** The repository's current worktree entries and attributed agents, read
   *  from whatever the worktree/session sources most recently returned —
   *  never re-fetched here (Decision 3: this primitive composes, it does
   *  not read a second source itself). */
  readonly worktreeEntries: readonly WorktreeEntry[]
  readonly agents: readonly AgentRecord[]
  readonly gh?: GhRunner
  readonly now?: () => Date
}

/** Fetches the open-item sweep, keeps the last good one on failure (Decision
 *  4), and — the one thing that makes this primitive more than a thin
 *  wrapper — fires the conditional `fetchItemsByNumber` re-check itself
 *  whenever the fresh sweep leaves orphan numbers, so `itemStates` stays
 *  dependent on a GitHub refresh rather than independently schedulable. */
export async function refreshGithub(cache: SourceCache, params: RefreshGithubParams): Promise<RefreshOutcome> {
  const now = params.now ?? (() => new Date())
  const fetch = await fetchPipelineItems({ repo: params.repo, vocabulary: params.vocabulary, gh: params.gh, now })
  const previous = cache.github.get(params.repoId) ?? null
  cache.github.set(params.repoId, projectOk(previous, fetch))

  if (fetch.ok) {
    const orphanNumbers = collectOrphanNumbers(fetch.items, params.worktreeEntries, params.agents)
    cache.itemStates.set(params.repoId, orphanNumbers.length === 0 ? null : await fetchItemsByNumber({ repo: params.repo, numbers: orphanNumbers, gh: params.gh, now }))
  }

  return fetch.ok
    ? { ok: true, at: fetch.fetchedAt, rateLimit: fetch.rateLimit }
    : { ok: false, at: fetch.fetchedAt, error: fetch.message, failureKind: fetch.kind }
}

export interface RefreshWorktreesParams {
  readonly repoId: RepoId
  readonly repoRoot: string
  readonly git?: GitRunner
  readonly now?: () => Date
}

export async function refreshWorktrees(cache: SourceCache, params: RefreshWorktreesParams): Promise<RefreshOutcome> {
  const read = await readWorktrees({ repoRoot: params.repoRoot, git: params.git, now: params.now })
  const previous = cache.worktrees.get(params.repoId) ?? null
  cache.worktrees.set(params.repoId, projectOk(previous, read))
  return read.ok ? { ok: true, at: read.readAt } : { ok: false, at: read.readAt, error: read.message }
}

export interface RefreshDenialsParams {
  readonly repoId: RepoId
  readonly repoRoot: string
  readonly git?: GitRunner
  readonly now?: () => Date
}

export async function refreshDenials(cache: SourceCache, params: RefreshDenialsParams): Promise<RefreshOutcome> {
  const read = await readDenials({ repoRoot: params.repoRoot, git: params.git, now: params.now })
  const previous = cache.denials.get(params.repoId) ?? null
  cache.denials.set(params.repoId, projectOk(previous, read))
  return read.ok ? { ok: true, at: read.readAt } : { ok: false, at: read.readAt, error: read.message }
}

export interface RefreshSessionsParams {
  readonly repos: Parameters<typeof readSessionState>[0]['repos']
  readonly reader?: Parameters<typeof readSessionState>[0]['reader']
  readonly claudeHome?: string
  readonly now?: () => Date
}

/** The one machine-wide call — every repository shares this cache slot. */
export async function refreshSessions(cache: SourceCache, params: RefreshSessionsParams): Promise<RefreshOutcome> {
  const scan = await readSessionState({ repos: params.repos, reader: params.reader, claudeHome: params.claudeHome, now: params.now })
  cache.sessions = projectOk(cache.sessions, scan)
  return scan.ok ? { ok: true, at: scan.scannedAt } : { ok: false, at: scan.scannedAt, error: scan.message }
}
