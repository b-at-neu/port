// One refresh primitive per source, each keeping the previous good value in place on a failed attempt. `watcher.ts` decides *when* to call these; no file here names a timer.
import { fetchItemsByNumber, fetchPipelineItems } from '../github/adapter'
import type { GhRunner } from '../github/adapter'
import { collectOrphanNumbers } from './attach'
import { readDenials } from '../local/denials'
import { readWorktrees } from '../local/worktrees'
import type { GitRunner } from '../local/worktrees'
import { readSessionState } from '../sessions/adapter'
import type { RepoId } from '../../shared/repos'
import type { LabelVocabulary } from '../../shared/labels/vocabulary'
import type { DenialsRead, WorktreeEntry, WorktreesRead } from '../../shared/local/types'
import type { AgentRecord, SessionScan } from '../../shared/sessions/types'
import type { ItemsByNumberFetch, PipelineFailureKind, PipelineFetch, RateLimitInfo } from '../../shared/github/types'

export interface SourceCache {
  readonly github: Map<RepoId, PipelineFetch>
  /** Keyed with the fetch it belongs to, never independently schedulable — `SOURCE_KINDS` deliberately excludes `itemStates`. */
  readonly itemStates: Map<RepoId, ItemsByNumberFetch | null>
  readonly worktrees: Map<RepoId, WorktreesRead>
  readonly denials: Map<RepoId, DenialsRead>
  /** One machine-wide scan, never per repository. */
  sessions: SessionScan | null
}

export function createSourceCache(): SourceCache {
  return { github: new Map(), itemStates: new Map(), worktrees: new Map(), denials: new Map(), sessions: null }
}

/** What every refresh primitive reports back for health bookkeeping — `schedule.ts` reads this, never the cache directly. */
export interface RefreshOutcome {
  readonly ok: boolean
  readonly at: string
  readonly error?: string
  /** GitHub-only — the window this attempt read, so `schedule.ts`'s `deferredUntil` can defer even a successful-but-low-headroom read. */
  readonly rateLimit?: RateLimitInfo | null
  /** GitHub-only — so a `rate-limited` failure can defer to `resetAt` rather than double the interval like any other failure. */
  readonly failureKind?: PipelineFailureKind | null
}

function projectOk<T extends { readonly ok: boolean }>(previous: T | null, attempt: T): T {
  return attempt.ok ? attempt : (previous ?? attempt)
}

export interface RefreshGithubParams {
  readonly repoId: RepoId
  readonly repo: { readonly owner: string; readonly name: string }
  readonly vocabulary: LabelVocabulary
  /** Read from whatever the worktree/session sources most recently returned — never re-fetched here; this primitive composes, it does not read a second source. */
  readonly worktreeEntries: readonly WorktreeEntry[]
  readonly agents: readonly AgentRecord[]
  readonly gh?: GhRunner
  readonly now?: () => Date
}

/** Fires the conditional `fetchItemsByNumber` re-check itself whenever the fresh sweep leaves orphan numbers, so `itemStates` stays dependent on a GitHub refresh. */
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
