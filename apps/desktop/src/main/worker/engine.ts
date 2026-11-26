import type { Platform } from '@/main/platform'
import { createGithubTracker } from '@/main/github/tracker'
import type { StateEngine } from '@/main/pipeline/context'
import type { SessionReader } from '@/types/sessions'
import { readSessionState } from '@/main/sessions/adapter'
import { createSdkSessionReader } from '@/main/sessions/reader'
import { createTailStore } from '@/main/sessions/tail'
import { runSearch } from '@/main/sessions/search/query'
import { projectFromCache } from '@/main/pipeline/board/read'
import { createSourceCache, refreshDenials, refreshGithub, refreshSessions, refreshWorktrees } from '@/main/pipeline/board/sources'

type EngineContext = Pick<Platform, 'git' | 'ghWrite' | 'githubHttp' | 'githubConditional' | 'sdk' | 'fs' | 'clock' | 'claudeHome'> & {
  /** Absent in the in-process fallback, which has no app data directory; transcripts then show a stage session's first message as it is. */
  readonly stagePromptsDir?: string
}

/** Owns the source cache and every CPU-bound read; the worker runs exactly this. */
export function createInProcessEngine(ctx: EngineContext, reader: SessionReader = createSdkSessionReader(ctx.sdk)): StateEngine {
  const cache = createSourceCache()
  const tails = createTailStore(ctx, ctx.stagePromptsDir)
  const now = (): Date => ctx.clock.now()
  const tracker = createGithubTracker({ githubHttp: ctx.githubHttp, githubConditional: ctx.githubConditional, ghWrite: ctx.ghWrite, git: ctx.git, clock: ctx.clock })
  const boardCtx = { githubHttp: ctx.githubHttp, clock: ctx.clock, tracker }

  return {
    refreshSessions: ({ repos }) => refreshSessions(ctx, cache, { repos, reader }),
    refreshWorktrees: ({ repoId, repoRoot }) => refreshWorktrees(ctx, cache, { repoId, repoRoot }),
    refreshDenials: ({ repoId, repoRoot }) => refreshDenials(ctx, cache, { repoId, repoRoot }),
    refreshGithub: ({ repoId, repo, vocabulary, verify, integration, tracked }) => {
      const worktrees = cache.worktrees.get(repoId)
      const worktreeEntries = worktrees?.ok ? worktrees.entries : []
      const agents = cache.sessions?.ok ? cache.sessions.agents.filter((agent) => agent.repoId === repoId) : []
      return refreshGithub(boardCtx, cache, { repoId, repo, vocabulary, verify, integration, tracked, worktreeEntries, agents })
    },
    precheckGithub: (params) => tracker.precheck(params),
    project: ({ repositories, views }) => Promise.resolve(projectFromCache(cache, repositories, now, views)),
    scanSessions: ({ repos }) => readSessionState(ctx, { repos, reader }),
    listSessions: () => reader(),
    search: (request) => runSearch(ctx, request),
    tailOpen: (request) => tails.openTail(request),
    tailPoll: (request) => tails.pollTail(request),
    tailClose: (request) => {
      tails.closeTail(request)
      return Promise.resolve()
    },
    forgetRepo: ({ repoId }) => {
      tracker.forget(repoId)
      return Promise.resolve()
    },
  }
}
