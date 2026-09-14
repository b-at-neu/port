import { describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandResult, GhResult } from '../platform'
import type { RepoId } from '../../shared/repos'
import { createSourceCache, refreshDenials, refreshGithub, refreshSessions, refreshWorktrees } from './sources'

const EMPTY_PIPELINE_STDOUT = JSON.stringify({ data: { repository: {}, rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-01-01T00:00:00Z' } } })

const REPO_1 = 'repo-1' as RepoId
const REPO_2 = 'repo-2' as RepoId

function okGh(stdout: string = EMPTY_PIPELINE_STDOUT): GhResult {
  return { ok: true, stdout, stderr: '' }
}

function failGh(): GhResult {
  return { ok: false, kind: 'unauthenticated', stdout: '', stderr: 'gh: (HTTP 401)' }
}

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

function failGit(): (args: readonly string[], cwd: string) => Promise<CommandResult> {
  return () => Promise.resolve({ ok: false, kind: 'not-found', command: 'git', searched: ['/usr/bin'] })
}

const REPO = { owner: 'o', name: 'r' }
const VOCAB = { labels: [], disabled: [], problems: [] }

describe('refreshGithub — Decision 4', () => {
  it('a failing attempt keeps the previous good fetch in the cache', async () => {
    const cache = createSourceCache()
    await refreshGithub(cache, { repoId: REPO_1, repo: REPO, vocabulary: VOCAB, worktreeEntries: [], agents: [], gh: () => Promise.resolve(okGh()) })
    const outcome = await refreshGithub(cache, { repoId: REPO_1, repo: REPO, vocabulary: VOCAB, worktreeEntries: [], agents: [], gh: () => Promise.resolve(failGh()) })
    expect(outcome.ok).toBe(false)
    expect(cache.github.get(REPO_1)?.ok).toBe(true)
  })

  it('a never-succeeded source projects its own failure, never an empty read', async () => {
    const cache = createSourceCache()
    await refreshGithub(cache, { repoId: REPO_1, repo: REPO, vocabulary: VOCAB, worktreeEntries: [], agents: [], gh: () => Promise.resolve(failGh()) })
    expect(cache.github.get(REPO_1)?.ok).toBe(false)
  })

  it('fetchItemsByNumber is not called when the orphan set is empty', async () => {
    const cache = createSourceCache()
    let sawItemsByNumberCall = false
    await refreshGithub(cache, {
      repoId: REPO_1,
      repo: REPO,
      vocabulary: VOCAB,
      worktreeEntries: [],
      agents: [],
      gh: (args) => {
        const document = args.find((a) => a.startsWith('query=')) ?? ''
        if (document.includes('issueOrPullRequest')) sawItemsByNumberCall = true
        return Promise.resolve(okGh())
      },
    })
    expect(sawItemsByNumberCall).toBe(false)
    expect(cache.itemStates.get(REPO_1)).toBeNull()
  })
})

describe('refreshWorktrees / refreshDenials — Decision 4', () => {
  it('a failing worktree read keeps the previous good entries', async () => {
    const cache = createSourceCache()
    await refreshWorktrees(cache, { repoId: REPO_1, repoRoot: '/repo', git: okGit() })
    const outcome = await refreshWorktrees(cache, { repoId: REPO_1, repoRoot: '/repo', git: failGit() })
    expect(outcome.ok).toBe(false)
    expect(cache.worktrees.get(REPO_1)?.ok).toBe(true)
  })

  it('a failing denials read keeps the previous good summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'port-sources-denials-'))
    const logPath = join(root, '.agents', 'denials.log')
    await mkdir(join(root, '.agents'), { recursive: true })
    await writeFile(logPath, '2026-01-01T00:00:00Z\tdeny\tport:port:impl-agent\tsome command\n', 'utf8')

    const cache = createSourceCache()
    await refreshDenials(cache, { repoId: REPO_1, repoRoot: root, git: okGit() })
    expect(cache.denials.get(REPO_1)?.ok).toBe(true)

    await chmod(logPath, 0o000)
    try {
      const outcome = await refreshDenials(cache, { repoId: REPO_1, repoRoot: root, git: okGit() })
      if (outcome.ok) {
        // Running as root (containers) can make chmod 000 unenforced — the
        // read-as-root direction is not what this test exercises.
        return
      }
      expect(outcome.ok).toBe(false)
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

    const cache = createSourceCache()
    let calls = 0
    await refreshSessions(cache, {
      repos: [
        { id: REPO_1, root: '/repo-1' },
        { id: REPO_2, root: '/repo-2' },
      ],
      claudeHome,
      reader: () => {
        calls += 1
        return Promise.resolve({ ok: true, sessions: [] })
      },
    })
    expect(calls).toBe(1)
    expect(cache.sessions?.ok).toBe(true)

    const outcome = await refreshSessions(cache, {
      repos: [{ id: REPO_1, root: '/repo-1' }],
      claudeHome,
      reader: () => Promise.resolve({ ok: false, kind: 'sdk-failed', message: 'boom' }),
    })
    expect(outcome.ok).toBe(false)
    expect(cache.sessions?.ok).toBe(true)
  })
})
