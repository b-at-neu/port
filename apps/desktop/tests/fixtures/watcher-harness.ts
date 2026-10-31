import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { RepositoryEntry } from '@/utils/repos'
import type { CommandResult, GhResult } from '@/types/platform'
import type { TimerFactory, TimerHandle } from '@/types/state'
import { RATE_LIMIT_REPLY, connection } from './pipeline-reply'

/** One ready issue: the sweep reply names it, and the detail read (`d0`) answers with an empty timeline. */
export function readyItemGh(signedInLogin: string, assignees: readonly string[], rateLimit: unknown = RATE_LIMIT_REPLY, labels: readonly string[] = ['ready']): (args: readonly string[]) => Promise<GhResult> {
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
  return (args) => {
    const document = args.find((arg) => arg.startsWith('query=')) ?? ''
    return Promise.resolve({ ok: true, stdout: JSON.stringify({ data: document.includes('d0:') ? detail : sweep }), stderr: '' })
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
