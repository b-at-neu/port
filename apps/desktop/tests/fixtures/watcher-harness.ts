import { resolveDisplayVocabulary } from '@/utils/labels/display'
import type { RepositoryEntry } from '@/utils/repos'
import type { CommandResult, ConditionalTransport, GitHubTransport } from '@/types/platform'
import type { BoardSnapshot } from '@/types/board'
import type { StateEngine } from '@/main/pipeline/context'
import type { PipelineWatcher, TimerFactory, TimerHandle } from '@/types/state'
import { createPipelineWatcher } from '@/main/pipeline/board/watcher'
import { createInProcessEngine } from '@/main/worker/engine'
import type { Repos } from '@/main/repos'
import { watcherContext, type WatcherContextOptions } from '../support/context'
import { createFakeClock, createFakePlatform } from '../support/fake-platform'
import { queryOf } from './github-http'
import { RATE_LIMIT_REPLY, connection } from './pipeline-reply'

type EngineCtx = Parameters<typeof createInProcessEngine>[0]

export interface WatcherRigOptions extends Pick<WatcherContextOptions, 'platform' | 'tickets' | 'stores' | 'dispatcher'> {
  readonly repositories?: readonly RepositoryEntry[]
  readonly repos?: Partial<Repos>
  readonly github?: GitHubTransport
  readonly conditional?: ConditionalTransport
  readonly git?: (args: readonly string[], cwd: string) => Promise<CommandResult>
  /** Members replaced on the in-process engine the watcher reads through `ctx.live`. */
  readonly engine?: Partial<StateEngine>
  readonly refused?: () => ReadonlySet<number>
}

/** A watcher over a test context whose engine is the real in-process one, on one shared fake clock and timer. */
export function watcherRig(options: WatcherRigOptions = {}) {
  const clock = createFakeClock('2026-01-01T00:00:00.000Z')
  const inner = createInProcessEngine(
    engineCtx({ git: options.git ?? fakeGit({ worktreeList: 0 }), githubHttp: options.github ?? offlineGithub, githubConditional: options.conditional ?? scriptedConditional().transport, clock }),
    () => Promise.resolve({ ok: true, sessions: [] }),
  )
  const engine: StateEngine = { ...inner, ...options.engine }
  const timer = makeFakeTimer()
  const ctx = watcherContext({
    platform: { ...options.platform, clock },
    repositories: options.repositories,
    repos: options.repos,
    tickets: options.tickets,
    stores: options.stores,
    dispatcher: options.dispatcher,
    live: { engine, ...(options.refused === undefined ? {} : { autoPlanner: { refused: options.refused } as never }) },
  })
  const watch = (sinks: { readonly onSnapshot?: (snapshot: BoardSnapshot) => void; readonly onTick?: (snapshot: BoardSnapshot) => void } = {}): PipelineWatcher => createPipelineWatcher(ctx, { onSnapshot: sinks.onSnapshot ?? (() => undefined), onTick: sinks.onTick, setTimer: timer.factory })
  return { ctx, clock, timer, engine, inner, watch }
}

/** A GitHub transport that is down, so a refresh reports a failure value instead of reaching the network. */
export const offlineGithub: GitHubTransport = () => Promise.resolve({ ok: false, kind: 'network', status: null, body: '', message: 'offline' })

/** The adapters an in-process engine reads, all unscripted fakes until a test passes its own. */
export function engineCtx(overrides: Partial<EngineCtx> = {}): EngineCtx {
  const { git, ghWrite, githubHttp, githubConditional, sdk, fs, clock, claudeHome } = createFakePlatform()
  return { git, ghWrite, githubHttp, githubConditional, sdk, fs, clock, claudeHome, ...overrides }
}

/** One ready issue: the sweep reply names it, and the detail read (`d0`) answers with an empty timeline. */
export function readyItemTransport(signedInLogin: string, assignees: readonly string[], rateLimit: unknown = RATE_LIMIT_REPLY, labels: readonly string[] = ['ready']): GitHubTransport {
  const issue = {
    number: 42,
    title: 'a ticket',
    url: 'https://github.com/o/a/issues/42',
    body: '',
    state: 'OPEN',
    assignees: { nodes: assignees.map((login) => ({ login })) },
    labels: { nodes: labels.map((name) => ({ name })) },
  }
  const sweep = { repository: { issues: connection([issue]), pullRequests: connection([]), repoLabels: { totalCount: 0, nodes: [] } }, rateLimit, viewer: { login: signedInLogin } }
  const detail = { repository: { d0: { timelineItems: { nodes: [] } } }, rateLimit }
  const tracked = { repository: { t0: issue }, rateLimit }
  return (request) => {
    const document = queryOf(request)
    const data = document.includes('d0:') ? detail : document.includes('t0: issue(') ? tracked : sweep
    return Promise.resolve({ ok: true, status: 200, headers: {}, body: JSON.stringify({ data }) })
  }
}

interface ScriptedConditional {
  readonly transport: ConditionalTransport
  readonly bump: () => void
  readonly fail: (on: boolean) => void
  readonly calls: () => number
}

/** A fake issues-list endpoint: `bump()` moves the ETag, a matching `If-None-Match` answers 304, and `fail(true)` answers 500. */
export function scriptedConditional(): ScriptedConditional {
  let version = 1
  let failing = false
  let calls = 0
  return {
    transport: (request) => {
      calls += 1
      if (failing) return Promise.resolve({ ok: false, kind: 'unknown', status: 500, body: '', message: 'GitHub returned HTTP 500' })
      const etag = `"v${String(version)}"`
      if (request.ifNoneMatch === etag) return Promise.resolve({ ok: true, notModified: true, status: 304, headers: { etag } })
      return Promise.resolve({ ok: true, notModified: false, status: 200, headers: { etag }, body: '[]' })
    },
    bump: () => {
      version += 1
    },
    fail: (on) => {
      failing = on
    },
    calls: () => calls,
  }
}

export function readyEntry(id: string, path: string, repo: string): Extract<RepositoryEntry, { status: 'ready' }> {
  return {
    id: id as RepositoryEntry['id'],
    path,
    displayName: repo,
    status: 'ready',
    config: {
      repo,
      owner: repo.split('/')[0] ?? '',
      name: repo.split('/')[1] ?? '',
      branches: { integration: 'dev', production: 'main' },
      commands: { worktrees: null, budget: null },
      concurrency: { sharedFiles: [], overlapThreshold: 2 },
      sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
      checkDispositions: {},
      overrides: [],
      models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
      modules: { approvalGate: true, release: true, scope: true },
      reviewCycleCap: 5,
      displayVocabulary: resolveDisplayVocabulary({}),
    },
    diagnostics: [],
  }
}

export function fakeGit(counts: { worktreeList: number }): (args: readonly string[], cwd: string) => Promise<CommandResult> {
  return (args, cwd) => {
    const [cmd, sub] = args
    if (cmd === 'worktree' && sub === 'list') {
      counts.worktreeList += 1
      return Promise.resolve({ ok: true, stdout: `worktree ${cwd}\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/main\n`, stderr: '' })
    }
    if (cmd === 'config' && sub === '--get-regexp') return Promise.resolve({ ok: false, kind: 'nonzero', code: 1, stdout: '', stderr: '' })
    if (cmd === 'log') return Promise.resolve({ ok: true, stdout: '', stderr: '' })
    if (cmd === 'rev-parse' && sub === '--git-common-dir') return Promise.resolve({ ok: true, stdout: '.git\n', stderr: '' })
    return Promise.resolve({ ok: true, stdout: '', stderr: '' })
  }
}

export function makeFakeTimer(): { readonly factory: TimerFactory; readonly fire: () => void; readonly isScheduled: () => boolean } {
  let current: (() => void) | null = null
  return {
    factory: (callback: () => void): TimerHandle => {
      current = callback
      return { clear: () => { current = null } }
    },
    fire: () => {
      const cb = current
      current = null
      cb?.()
    },
    isScheduled: () => current !== null,
  }
}
