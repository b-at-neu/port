import { claudeHomeDir, hostFs, type Platform } from '@/main/platform'
import { gh } from '@/main/platform/gh'
import { defaultGitRunner } from '@/main/platform/git'
import { githubConditional, githubHttp } from '@/main/platform/github-http'
import { defaultSdk } from '@/main/platform/sdk'
import { createGithubTracker } from '@/main/github/tracker'
import type { StateEngine } from '@/types/offload'
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

interface HostEngineOverrides {
  readonly github?: EngineContext['githubHttp']
  readonly conditional?: EngineContext['githubConditional']
  readonly git?: EngineContext['git']
  readonly claudeHome?: string
  readonly now?: () => Date
}

/** The in-process engine over the host adapters, each replaceable; the watcher falls back to it when it is given no worker-backed engine. */
export function createHostEngine(overrides: HostEngineOverrides, reader?: SessionReader): StateEngine {
  return createInProcessEngine(
    {
      git: overrides.git ?? defaultGitRunner(),
      ghWrite: gh,
      githubHttp: overrides.github ?? githubHttp,
      githubConditional: overrides.conditional ?? githubConditional,
      sdk: defaultSdk,
      fs: hostFs,
      clock: { now: overrides.now ?? (() => new Date()) },
      claudeHome: overrides.claudeHome ?? claudeHomeDir(),
    },
    reader,
  )
}

/** Owns the source cache and every CPU-bound read; the worker runs exactly this. */
export function createInProcessEngine(ctx: EngineContext, reader: SessionReader = createSdkSessionReader(ctx.sdk)): StateEngine {
  const cache = createSourceCache()
  const tails = createTailStore(ctx, ctx.stagePromptsDir)
  const now = (): Date => ctx.clock.now()
  const read = { githubHttp: ctx.githubHttp, clock: ctx.clock }
  const tracker = createGithubTracker({ githubHttp: ctx.githubHttp, githubConditional: ctx.githubConditional, ghWrite: ctx.ghWrite, git: ctx.git, clock: ctx.clock })

  return {
    refreshSessions: ({ repos }) => refreshSessions(cache, { repos, reader, claudeHome: ctx.claudeHome, now }),
    refreshWorktrees: ({ repoId, repoRoot }) => refreshWorktrees(cache, { repoId, repoRoot, git: ctx.git, now }),
    refreshDenials: ({ repoId, repoRoot }) => refreshDenials(cache, { repoId, repoRoot, git: ctx.git, now }),
    refreshGithub: ({ repoId, repo, vocabulary, verify, integration, tracked }) => {
      const worktrees = cache.worktrees.get(repoId)
      const worktreeEntries = worktrees?.ok ? worktrees.entries : []
      const agents = cache.sessions?.ok ? cache.sessions.agents.filter((agent) => agent.repoId === repoId) : []
      return refreshGithub(cache, { repoId, repo, vocabulary, verify, integration, tracked, worktreeEntries, agents, ctx: read })
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
