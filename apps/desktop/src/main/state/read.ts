// `watcher.ts` calls the same two primitives (`refreshGithub` and friends, `projectFromCache`) on its own cadence rather than a second copy of this composition.
import type { GhRunner } from '../github/adapter'
import { readSessionState } from '../sessions/adapter'
import type { GitRunner } from '../local/worktrees'
import type { RepositoryEntry } from '../../shared/repos'
import type { FreshnessEntry, PipelineState, RepositoryState } from '../../shared/state/types'
import { reconcileRepository } from './reconcile'
import type { RepoSessionSlice } from './reconcile'
import { createSourceCache, refreshDenials, refreshGithub, refreshSessions, refreshWorktrees } from './sources'
import type { SourceCache } from './sources'

export interface ReadPipelineStateParams {
  readonly repositories: readonly RepositoryEntry[]
  readonly gh?: GhRunner
  readonly git?: GitRunner
  readonly sessionReader?: Parameters<typeof readSessionState>[0]['reader']
  /** Forwarded verbatim to `readSessionState`, so `read.test.ts` can attribute a fake session without touching the real machine's transcripts. */
  readonly claudeHome?: string
  readonly now?: () => Date
}

export function isReady(entry: RepositoryEntry): entry is Extract<RepositoryEntry, { status: 'ready' }> {
  return 'status' in entry && entry.status === 'ready'
}

function splitRepo(repo: string): { readonly owner: string; readonly name: string } {
  const [owner, name] = repo.split('/')
  return { owner: owner ?? '', name: name ?? '' }
}

/** Builds one `PipelineState` from whatever a `SourceCache` currently holds — no I/O of its own. Shared by `readPipelineState` and `watcher.ts` so the join logic exists once. */
export function projectFromCache(cache: SourceCache, repositories: readonly RepositoryEntry[], now: () => Date = () => new Date()): PipelineState {
  const readAt = now().toISOString()
  const sessionScan = cache.sessions ?? { ok: false as const, kind: 'sdk-unavailable' as const, message: 'sessions have not been scanned yet', scannedAt: readAt }
  const sessionsFreshness: FreshnessEntry = sessionScan.ok ? { at: sessionScan.scannedAt } : { unavailable: sessionScan.message }

  const repositoriesOut: RepositoryState[] = []
  for (const entry of repositories) {
    if (!isReady(entry)) {
      repositoriesOut.push({ ok: false, repoId: entry.id, displayName: entry.displayName, reason: 'not-ready', problem: entry.problem })
      continue
    }

    const pipelineFetch = cache.github.get(entry.id) ?? { ok: false as const, kind: 'no-data' as const, message: 'not read yet', fetchedAt: readAt }
    const worktrees = cache.worktrees.get(entry.id) ?? { ok: false as const, kind: 'not-found' as const, message: 'not read yet', readAt }
    const denials = cache.denials.get(entry.id) ?? { ok: false as const, kind: 'io' as const, message: 'not read yet', path: '', readAt }
    const itemsByNumberFetch = cache.itemStates.get(entry.id) ?? null

    const repoAgents = sessionScan.ok ? sessionScan.agents.filter((a) => a.repoId === entry.id) : []
    const repoSessionRecords = sessionScan.ok ? sessionScan.sessions.filter((s) => s.repoId === entry.id) : []
    const repoSessions: RepoSessionSlice = { agents: repoAgents, sessions: repoSessionRecords, available: sessionScan.ok, freshness: sessionsFreshness }

    repositoriesOut.push(reconcileRepository({ entry, pipelineFetch, itemsByNumberFetch, repoSessions, worktrees, denials }))
  }

  return { repositories: repositoriesOut, sessions: sessionScan, readAt }
}

/** A non-`ready` entry becomes its `reason: 'not-ready'` state without any read at all. */
export async function readPipelineState(params: ReadPipelineStateParams): Promise<PipelineState> {
  const now = params.now ?? (() => new Date())
  const cache = createSourceCache()
  const readyEntries = params.repositories.filter(isReady)

  await refreshSessions(cache, { repos: readyEntries.map((entry) => ({ id: entry.id, root: entry.path })), reader: params.sessionReader, claudeHome: params.claudeHome, now })

  for (const entry of readyEntries) {
    await refreshWorktrees(cache, { repoId: entry.id, repoRoot: entry.path, git: params.git, now })
    await refreshDenials(cache, { repoId: entry.id, repoRoot: entry.path, git: params.git, now })

    const worktrees = cache.worktrees.get(entry.id)
    const worktreeEntries = worktrees?.ok ? worktrees.entries : []
    const sessions = cache.sessions
    const agents = sessions?.ok ? sessions.agents.filter((a) => a.repoId === entry.id) : []
    const repo = splitRepo(entry.config.repo)
    await refreshGithub(cache, { repoId: entry.id, repo, vocabulary: entry.config.vocabulary, worktreeEntries, agents, gh: params.gh, now })
  }

  return projectFromCache(cache, params.repositories, now)
}
