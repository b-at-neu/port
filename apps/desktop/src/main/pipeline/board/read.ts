import type { SourceCache, RepoSessionSlice } from '@/types/state'

// `watcher.ts` calls the same two primitives (`refreshGithub` and friends, `projectFromCache`) on its own cadence rather than a second copy of this composition.
import type { GitHubTransport } from '@/types/platform'
import { claudeHomeDir, hostFs } from '@/main/platform'
import { defaultGitRunner } from '@/main/platform/git'
import { readBoardIssues } from '@/main/github/tracker/board'
import { githubHttp } from '@/main/platform/github-http'
import type { BoardIssuesParams } from '@/types/tracker'
import { defaultSdk } from '@/main/platform/sdk'
import type { SessionReader } from '@/types/sessions'
import type { GitRunner } from '@/types/platform'
import type { RepositoryEntry } from '@/utils/repos'
import { verifiableVocabularyOf } from '@/utils/labels/display'
import type { PipelineView } from '@/types/pipeline-state'
import type { FreshnessEntry, PipelineState, RepositoryState } from '@/types/state'
import { reconcileRepository } from '@/main/pipeline/board/reconcile'

import { createSourceCache, refreshDenials, refreshGithub, refreshSessions, refreshWorktrees } from '@/main/pipeline/board/sources'


interface ReadPipelineStateParams {
  readonly repositories: readonly RepositoryEntry[]
  readonly github?: GitHubTransport
  readonly git?: GitRunner
  readonly sessionReader?: SessionReader
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
export function projectFromCache(cache: SourceCache, repositories: readonly RepositoryEntry[], now: () => Date = () => new Date(), views: Readonly<Record<string, PipelineView>> = {}): PipelineState {
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

    repositoriesOut.push(reconcileRepository({ entry, pipelineFetch, itemsByNumberFetch, repoSessions, worktrees, denials, view: views[entry.id] }))
  }

  return { repositories: repositoriesOut, sessions: sessionScan, readAt }
}

/** A non-`ready` entry becomes its `reason: 'not-ready'` state without any read at all. */
export async function readPipelineState(params: ReadPipelineStateParams): Promise<PipelineState> {
  const now = params.now ?? (() => new Date())
  const cache = createSourceCache()
  const readyEntries = params.repositories.filter(isReady)
  const git = params.git ?? defaultGitRunner()
  const clock = { now }
  const transport = params.github ?? githubHttp
  const readCtx = { githubHttp: transport, clock }
  const tracker = { readBoardIssues: (boardParams: BoardIssuesParams) => readBoardIssues(readCtx, boardParams) }
  const ctx = { githubHttp: transport, git, fs: hostFs, sdk: defaultSdk, claudeHome: params.claudeHome ?? claudeHomeDir(), clock, tracker }

  await refreshSessions(ctx, cache, { repos: readyEntries.map((entry) => ({ id: entry.id, root: entry.path })), reader: params.sessionReader })

  for (const entry of readyEntries) {
    await refreshWorktrees(ctx, cache, { repoId: entry.id, repoRoot: entry.path })
    await refreshDenials(ctx, cache, { repoId: entry.id, repoRoot: entry.path })

    const worktrees = cache.worktrees.get(entry.id)
    const worktreeEntries = worktrees?.ok ? worktrees.entries : []
    const sessions = cache.sessions
    const agents = sessions?.ok ? sessions.agents.filter((a) => a.repoId === entry.id) : []
    const repo = splitRepo(entry.config.repo)
    await refreshGithub(ctx, cache, { repoId: entry.id, repo, vocabulary: entry.config.vocabulary, verify: verifiableVocabularyOf(entry.config), integration: entry.config.branches.integration, worktreeEntries, agents })
  }

  return projectFromCache(cache, params.repositories, now)
}
