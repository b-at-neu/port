import type { ConditionalTransport, GitHubTransport, GitRunner } from '@/types/platform'
import { createGithubTracker } from '@/main/github/tracker'
import { gh } from '@/main/platform/gh'
import { defaultGitRunner } from '@/main/platform/git'
import { githubConditional, githubHttp } from '@/main/platform/github-http'
import type { StateEngine } from '@/types/offload'
import type { SessionReader } from '@/types/sessions'
import { readSessionState } from '@/main/sessions/adapter'
import { createSdkSessionReader } from '@/main/sessions/reader'
import { createTailStore } from '@/main/sessions/tail'
import { runSearch } from '@/main/sessions/search/query'
import { projectFromCache } from '@/main/pipeline/board/read'
import { createSourceCache, refreshDenials, refreshGithub, refreshSessions, refreshWorktrees } from '@/main/pipeline/board/sources'

interface InProcessEngineParams {
  readonly github?: GitHubTransport
  readonly conditional?: ConditionalTransport
  readonly git?: GitRunner
  readonly sessionReader?: SessionReader
  readonly claudeHome?: string
  readonly now?: () => Date
}

/** Owns the source cache and every CPU-bound read; the worker runs exactly this, and the watcher defaults to it in tests. */
export function createInProcessEngine(params: InProcessEngineParams = {}): StateEngine {
  const cache = createSourceCache()
  const tails = createTailStore()
  const now = params.now ?? (() => new Date())
  const reader = params.sessionReader ?? createSdkSessionReader()
  const clock = { now }
  const read = { githubHttp: params.github ?? githubHttp, clock }
  const tracker = createGithubTracker({ githubHttp: read.githubHttp, githubConditional: params.conditional ?? githubConditional, ghWrite: gh, git: params.git ?? defaultGitRunner(), clock })

  return {
    refreshSessions: ({ repos }) => refreshSessions(cache, { repos, reader: params.sessionReader, claudeHome: params.claudeHome, now }),
    refreshWorktrees: ({ repoId, repoRoot }) => refreshWorktrees(cache, { repoId, repoRoot, git: params.git, now }),
    refreshDenials: ({ repoId, repoRoot }) => refreshDenials(cache, { repoId, repoRoot, git: params.git, now }),
    refreshGithub: ({ repoId, repo, vocabulary, verify, integration, tracked }) => {
      const worktrees = cache.worktrees.get(repoId)
      const worktreeEntries = worktrees?.ok ? worktrees.entries : []
      const agents = cache.sessions?.ok ? cache.sessions.agents.filter((agent) => agent.repoId === repoId) : []
      return refreshGithub(cache, { repoId, repo, vocabulary, verify, integration, tracked, worktreeEntries, agents, ctx: read })
    },
    precheckGithub: (params) => tracker.precheck(params),
    project: ({ repositories, views }) => Promise.resolve(projectFromCache(cache, repositories, now, views)),
    scanSessions: ({ repos }) => readSessionState({ repos, reader: params.sessionReader, claudeHome: params.claudeHome, now }),
    listSessions: () => reader(),
    search: (request) => runSearch(request),
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
