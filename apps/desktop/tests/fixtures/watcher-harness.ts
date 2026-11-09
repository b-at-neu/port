import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { RepositoryEntry } from '@/utils/repos'
import type { CommandResult, ConditionalTransport, GitHubTransport } from '@/types/platform'
import type { TimerFactory, TimerHandle } from '@/types/state'
import { queryOf } from './github-http'
import { RATE_LIMIT_REPLY, connection } from './pipeline-reply'

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
  return (request) => {
    const document = queryOf(request)
    return Promise.resolve({ ok: true, status: 200, headers: {}, body: JSON.stringify({ data: document.includes('d0:') ? detail : sweep }) })
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
      vocabulary: resolveVocabulary({}),
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
