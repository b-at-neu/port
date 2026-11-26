import { describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandResult } from '@/types/platform'
import type { GitHubHttpResult } from '@/types/platform'
import type { RepoId } from '@/utils/repos'
import { hostFs } from '@/main/platform'
import { createSourceCache, refreshDenials, refreshGithub, refreshSessions, refreshWorktrees } from '@/main/pipeline/board/sources'
import { boardCtx, httpFail, httpOk, queryOf } from '../../../../fixtures/github-http'
import { EMPTY_PIPELINE_BODY } from '../../../../fixtures/pipeline-reply'
import { createFakePlatform } from '../../../../support/fake-platform'

const REPO_1 = 'repo-1' as RepoId
const REPO_2 = 'repo-2' as RepoId

const okGh = (body: string = EMPTY_PIPELINE_BODY): GitHubHttpResult => httpOk(body)
const failGh = (): GitHubHttpResult => httpFail('unauthenticated', 401)

function okGit(): (args: readonly string[], cwd: string) => Promise<CommandResult> {
  return (args, cwd) => {
    const [cmd, sub] = args
    if (cmd === 'worktree' && sub === 'list') return Promise.resolve({ ok: true, stdout: `worktree ${cwd}\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/main\n`, stderr: '' })
    if (cmd === 'config' && sub === '--get-regexp') return Promise.resolve({ ok: false, kind: 'nonzero', code: 1, stdout: '', stderr: '' })
    if (cmd === 'log') return Promise.resolve({ ok: true, stdout: '', stderr: '' })
    if (cmd === 'rev-parse' && sub === '--git-common-dir') return Promise.resolve({ ok: true, stdout: '.git\n', stderr: '' })
    return Promise.resolve({ ok: true, stdout: '', stderr: '' })
  }
}

const failGit = (): ((args: readonly string[], cwd: string) => Promise<CommandResult>) => () => Promise.resolve({ ok: false, kind: 'not-found', command: 'git', searched: ['/usr/bin'] })

const REPO = { owner: 'o', name: 'r' }
const VOCAB = { labels: [], disabled: [], problems: [] }
const GITHUB = { repoId: REPO_1, repo: REPO, vocabulary: VOCAB, integration: 'dev', worktreeEntries: [], agents: [] }

describe('refreshGithub — Decision 4', () => {
  it('a failing attempt keeps the previous good fetch in the cache', async () => {
    const cache = createSourceCache()
    await refreshGithub(boardCtx(() => Promise.resolve(okGh())), cache, GITHUB)
    const outcome = await refreshGithub(boardCtx(() => Promise.resolve(failGh())), cache, GITHUB)
    expect(outcome.ok).toBe(false)
    expect(cache.github.get(REPO_1)?.ok).toBe(true)
  })

  it('a never-succeeded source projects its own failure, never an empty read', async () => {
    const cache = createSourceCache()
    await refreshGithub(boardCtx(() => Promise.resolve(failGh())), cache, GITHUB)
    expect(cache.github.get(REPO_1)?.ok).toBe(false)
  })

  it('fetchItemsByNumber is not called when the orphan set is empty', async () => {
    const cache = createSourceCache()
    let sawItemsByNumberCall = false
    await refreshGithub(
      boardCtx((request) => {
        if (queryOf(request).includes('issueOrPullRequest')) sawItemsByNumberCall = true
        return Promise.resolve(okGh())
      }),
      cache,
      GITHUB,
    )
    expect(sawItemsByNumberCall).toBe(false)
    expect(cache.itemStates.get(REPO_1)).toBeNull()
  })
})

describe('refreshWorktrees / refreshDenials — Decision 4', () => {
  it('a failing worktree read keeps the previous good entries', async () => {
    const cache = createSourceCache()
    await refreshWorktrees({ ...createFakePlatform(), git: okGit() }, cache, { repoId: REPO_1, repoRoot: '/repo' })
    const outcome = await refreshWorktrees({ ...createFakePlatform(), git: failGit() }, cache, { repoId: REPO_1, repoRoot: '/repo' })
    expect(outcome.ok).toBe(false)
    expect(cache.worktrees.get(REPO_1)?.ok).toBe(true)
  })

  it('a failing denials read keeps the previous good summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'port-sources-denials-'))
    const logPath = join(root, '.agents', 'denials.log')
    await mkdir(join(root, '.agents'), { recursive: true })
    await writeFile(logPath, '2026-01-01T00:00:00Z\tdeny\tport:port:impl-agent\tsome command\n', 'utf8')

    const ctx = { ...createFakePlatform(), git: okGit(), fs: hostFs }
    const cache = createSourceCache()
    await refreshDenials(ctx, cache, { repoId: REPO_1, repoRoot: root })
    expect(cache.denials.get(REPO_1)?.ok).toBe(true)

    await chmod(logPath, 0o000)
    try {
      const outcome = await refreshDenials(ctx, cache, { repoId: REPO_1, repoRoot: root })
      // Running as root (containers) can make chmod 000 unenforced — the read-as-root direction is not what this test exercises.
      if (outcome.ok) return
      expect(cache.denials.get(REPO_1)?.ok).toBe(true)
    } finally {
      await chmod(logPath, 0o644)
    }
  })
})

describe('refreshSessions', () => {
  it('exactly one readSessionState call regardless of repository count, keeping the last good scan on failure', async () => {
    const claudeHome = await mkdtemp(join(tmpdir(), 'port-sources-sessions-'))
    await mkdir(join(claudeHome, 'projects'), { recursive: true })
    const ctx = { ...createFakePlatform(), fs: hostFs, claudeHome }

    const cache = createSourceCache()
    let calls = 0
    await refreshSessions(ctx, cache, {
      repos: [
        { id: REPO_1, root: '/repo-1' },
        { id: REPO_2, root: '/repo-2' },
      ],
      reader: () => {
        calls += 1
        return Promise.resolve({ ok: true, sessions: [] })
      },
    })
    expect(calls).toBe(1)
    expect(cache.sessions?.ok).toBe(true)

    const outcome = await refreshSessions(ctx, cache, { repos: [{ id: REPO_1, root: '/repo-1' }], reader: () => Promise.resolve({ ok: false, kind: 'sdk-failed', message: 'boom' }) })
    expect(outcome.ok).toBe(false)
    expect(cache.sessions?.ok).toBe(true)
  })
})
