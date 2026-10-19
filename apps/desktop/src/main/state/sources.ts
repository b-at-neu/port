// One refresh primitive per source, each keeping the previous good value in place on a failed attempt. `watcher.ts` decides *when* to call these; no file here names a timer.
import { fetchItemsByNumber } from '@/main/github/adapter'
import { fetchPipelineItems } from '@/main/github/pipeline'
import type { GhRunner } from '@/types/platform'
import { collectOrphanNumbers } from '@/main/state/attach'
import { readDenials } from '@/main/local/denials'
import { readWorktrees } from '@/main/local/worktrees'
import type { GitRunner } from '@/types/platform'
import { readSessionState } from '@/main/sessions/adapter'
import type { RepoId } from '@/utils/repos'
import type { LabelVocabulary } from '@/utils/labels/vocabulary'
import type { WorktreeEntry } from '@/types/local'
import type { AgentRecord } from '@/types/sessions'
import type { RefreshOutcome, SourceCache } from '@/types/state'

export function createSourceCache(): SourceCache {
  return { github: new Map(), itemStates: new Map(), worktrees: new Map(), denials: new Map(), sessions: null }
}

function projectOk<T extends { readonly ok: boolean }>(previous: T | null, attempt: T): T {
  return attempt.ok ? attempt : (previous ?? attempt)
}

interface RefreshGithubParams {
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

interface RefreshWorktreesParams {
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

interface RefreshDenialsParams {
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

interface RefreshSessionsParams {
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
