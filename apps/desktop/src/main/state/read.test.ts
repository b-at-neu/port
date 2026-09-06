import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pathOps } from '../platform'
import type { CommandResult, GhResult } from '../platform'
import type { RepositoryEntry } from '../../shared/repos'
import { resolveVocabulary } from '../../shared/labels/vocabulary'
import { readPipelineState } from './read'

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

async function makeSession(claudeHome: string, projectName: string, sessionId: string): Promise<void> {
  const projectDir = join(claudeHome, 'projects', projectName)
  await mkdir(projectDir, { recursive: true })
  await writeFile(join(projectDir, `${sessionId}.jsonl`), '')
}

function rawSession(overrides: { readonly sessionId: string; readonly cwd: string | null }) {
  return { summary: null, lastModified: new Date().toISOString(), customTitle: null, firstPrompt: null, gitBranch: null, ...overrides }
}

function readyEntry(id: string, path: string, repo: string): Extract<RepositoryEntry, { status: 'ready' }> {
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
      models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
      modules: { approvalGate: true, release: true, scope: true },
      reviewCycleCap: 5,
      vocabulary: resolveVocabulary({}),
    },
    diagnostics: [],
  }
}

/** Every alias this fake resolves to an empty connection — `mapPipelineItems`
 *  reads an unrecognised alias as `undefined` and simply skips it, so this
 *  is a valid "no items" response regardless of how many labels the
 *  vocabulary enables. */
const EMPTY_PIPELINE_STDOUT = JSON.stringify({ data: { repository: {}, rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-01-01T00:00:00Z' } } })

function fakeGit(): (args: readonly string[], cwd: string) => Promise<CommandResult> {
  return (args, cwd) => {
    const [cmd, sub] = args
    if (cmd === 'worktree' && sub === 'list') {
      return Promise.resolve({ ok: true, stdout: `worktree ${cwd}\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/main\n`, stderr: '' })
    }
    if (cmd === 'config' && sub === '--get-regexp') {
      return Promise.resolve({ ok: false, kind: 'nonzero', code: 1, stdout: '', stderr: '' })
    }
    if (cmd === 'log') {
      return Promise.resolve({ ok: true, stdout: '', stderr: '' })
    }
    if (cmd === 'rev-parse' && sub === '--git-common-dir') {
      return Promise.resolve({ ok: true, stdout: '.git\n', stderr: '' })
    }
    return Promise.resolve({ ok: true, stdout: '', stderr: '' })
  }
}

describe('readPipelineState', () => {
  it('two repositories reconcile from one session scan, each session attributed to the right one', async () => {
    const claudeHome = await makeTempDir('port-state-read-')
    const repoARoot = await makeTempDir('port-state-repo-a-')
    const repoBRoot = await makeTempDir('port-state-repo-b-')
    const SESSION_A = '11111111-0000-0000-0000-000000000001'
    const SESSION_B = '11111111-0000-0000-0000-000000000002'
    await makeSession(claudeHome, 'project-a', SESSION_A)
    await makeSession(claudeHome, 'project-b', SESSION_B)

    let readerCalls = 0
    const result = await readPipelineState({
      repositories: [readyEntry('repo-a', repoARoot, 'o/a'), readyEntry('repo-b', repoBRoot, 'o/b')],
      gh: () => Promise.resolve({ ok: true, stdout: EMPTY_PIPELINE_STDOUT, stderr: '' } satisfies GhResult),
      git: fakeGit(),
      claudeHome,
      sessionReader: () => {
        readerCalls += 1
        return Promise.resolve({
          ok: true,
          sessions: [rawSession({ sessionId: SESSION_A, cwd: repoARoot }), rawSession({ sessionId: SESSION_B, cwd: repoBRoot })],
        })
      },
    })

    expect(result.repositories).toHaveLength(2)
    expect(result.sessions.ok).toBe(true)
    if (!result.sessions.ok) throw new Error('unreachable')
    const sessionA = result.sessions.sessions.find((s) => s.sessionId === SESSION_A)
    const sessionB = result.sessions.sessions.find((s) => s.sessionId === SESSION_B)
    expect(sessionA?.repoId).toBe('repo-a')
    expect(sessionB?.repoId).toBe('repo-b')
    // Exactly one machine-wide scan, regardless of repository count.
    expect(readerCalls).toBe(1)
  })

  it('a non-ready entry survives as a state carrying its RepoProblem, never dropped', async () => {
    const notReady: RepositoryEntry = {
      id: 'repo-bad' as RepositoryEntry['id'],
      path: '/does/not/matter',
      displayName: 'o/bad',
      problem: { kind: 'not-a-git-repository' },
      diagnostics: [],
    }
    const result = await readPipelineState({
      repositories: [notReady],
      gh: () => Promise.resolve({ ok: true, stdout: EMPTY_PIPELINE_STDOUT, stderr: '' } satisfies GhResult),
      git: fakeGit(),
      sessionReader: () => Promise.resolve({ ok: true, sessions: [] }),
    })
    expect(result.repositories).toHaveLength(1)
    const state = result.repositories[0]
    expect(state?.ok).toBe(false)
    if (!state || state.ok || state.reason !== 'not-ready') throw new Error('unreachable')
    expect(state.problem).toEqual({ kind: 'not-a-git-repository' })
  })

  it('a GitHub failure on one repository leaves the other intact', async () => {
    const repoARoot = await makeTempDir('port-state-repo-a-')
    const repoBRoot = await makeTempDir('port-state-repo-b-')
    const result = await readPipelineState({
      repositories: [readyEntry('repo-a', repoARoot, 'owner-a/repo'), readyEntry('repo-b', repoBRoot, 'owner-b/repo')],
      gh: (args) => {
        const isRepoA = args.some((a) => a === 'owner=owner-a')
        if (isRepoA) return Promise.resolve({ ok: false, kind: 'unauthenticated', stdout: '', stderr: 'gh: (HTTP 401)' } satisfies GhResult)
        return Promise.resolve({ ok: true, stdout: EMPTY_PIPELINE_STDOUT, stderr: '' } satisfies GhResult)
      },
      git: fakeGit(),
      sessionReader: () => Promise.resolve({ ok: true, sessions: [] }),
    })
    const stateA = result.repositories.find((r) => r.repoId === 'repo-a')
    const stateB = result.repositories.find((r) => r.repoId === 'repo-b')
    expect(stateA?.ok).toBe(false)
    expect(stateB?.ok).toBe(true)
  })

  it('fetchItemsByNumber is not called when the orphan set is empty', async () => {
    const repoRoot = await makeTempDir('port-state-repo-')
    let sawItemsByNumberCall = false
    await readPipelineState({
      repositories: [readyEntry('repo-a', repoRoot, 'o/a')],
      gh: (args) => {
        const document = args.find((a) => a.startsWith('query=')) ?? ''
        if (document.includes('issueOrPullRequest')) sawItemsByNumberCall = true
        return Promise.resolve({ ok: true, stdout: EMPTY_PIPELINE_STDOUT, stderr: '' } satisfies GhResult)
      },
      git: fakeGit(),
      sessionReader: () => Promise.resolve({ ok: true, sessions: [] }),
    })
    expect(sawItemsByNumberCall).toBe(false)
  })
})

// Gated exactly as gh.test.ts gates on ghAuthStatus() and sessions'
// adapter.test.ts gates on <claudeHome>/projects existing — this machine's
// real state is the fixture, so CI (which has neither) skips it.
const REAL_CLAUDE_HOME = join(homedir(), '.claude')
const hasRealProjects = await pathExists(join(REAL_CLAUDE_HOME, 'projects'))

describe.skipIf(!hasRealProjects)('readPipelineState — live', () => {
  it(
    'every item carries a non-null status, every stalled item carries a statusEvidence, and freshness.github.at is populated',
    async (ctx) => {
      const { ghAuthStatus, ghJson } = await import('../platform')
      const auth = await ghAuthStatus()
      if (!auth.ok || !auth.authenticated) {
        ctx.skip()
        return
      }
      const repoInfo = await ghJson<{ nameWithOwner: string }>(['repo', 'view', '--json', 'nameWithOwner'])
      if (!repoInfo.ok) {
        ctx.skip()
        return
      }

      const entry = readyEntry(pathOps.pathKey(process.cwd()), process.cwd(), repoInfo.data.nameWithOwner)
      const result = await readPipelineState({ repositories: [entry] })

      const state = result.repositories[0]
      expect(state?.ok).toBe(true)
      if (!state || !state.ok) throw new Error('unreachable')
      for (const item of state.items) {
        expect(item.status).not.toBeNull()
        if (item.status === 'stalled') expect(item.statusEvidence).not.toBeNull()
      }
      expect('at' in state.freshness.github).toBe(true)
      console.log(`readPipelineState live case: items=${String(state.items.length)}`)
    },
    30_000,
  )
})
