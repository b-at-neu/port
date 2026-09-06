import { describe, expect, it } from 'vitest'
import { createPathOps } from '../platform'
import type { CommandResult } from '../platform'
import type { WorktreesGitRunner } from '../local'
import { GH_RESOLUTION_FAILED_SENTINEL, readWorktreeReport, SCRIPT_FAIL_PREFIX } from './report'
import type { NodeRunner } from './report'

const posixPathOps = createPathOps('posix', { home: '/home/op' })
const win32PathOps = createPathOps('win32', { home: 'C:\\Users\\op' })

function ok(stdout: string): CommandResult {
  return { ok: true, stdout, stderr: '' }
}

function nonzero(stderr: string, code = 1): CommandResult {
  return { ok: false, kind: 'nonzero', code, stdout: '', stderr }
}

function payload(overrides: Record<string, unknown> = {}, candidateOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    mainRoot: '/repo',
    integrationRef: 'origin/dev',
    candidates: [
      {
        path: '/repo/.claude/worktrees/impl-42',
        branch: '42-feature',
        head: 'deadbeef',
        state: 'done',
        reason: '#42 merged (branch-name)',
        rung: 'branch-name',
        issue: 42,
        locked: false,
        lockReason: null,
        dirtyFiles: 0,
        removed: false,
        branchDeleted: null,
        error: null,
        ...candidateOverrides,
      },
    ],
    orphanDirs: [],
    summary: { registered: 1, removed: 0, kept: 1, byState: { done: 1 } },
    ...overrides,
  })
}

describe('readWorktreeReport', () => {
  it('reports not-configured without spawning anything when commands.worktrees is null', async () => {
    let called = false
    const runNode: NodeRunner = () => {
      called = true
      return Promise.resolve(ok(''))
    }
    const result = await readWorktreeReport({ repoRoot: '/repo', worktreesCommand: null, runNode, pathOps: posixPathOps })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('not-configured')
    expect(typeof result.message).toBe('string')
    expect(typeof result.readAt).toBe('string')
    expect(called).toBe(false)
  })

  it('returns a clean online report, appending report --json', async () => {
    let seenArgs: readonly string[] = []
    const runNode: NodeRunner = (args) => {
      seenArgs = args
      return Promise.resolve(ok(payload()))
    }
    const result = await readWorktreeReport({
      repoRoot: '/repo',
      worktreesCommand: 'node plugins/port/templates/worktrees.mjs',
      runNode,
      pathOps: posixPathOps,
    })
    expect(seenArgs).toEqual(['plugins/port/templates/worktrees.mjs', 'report', '--json'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.githubResolution).toBe('resolved')
    expect(result.porcelainJoin).toBe('unavailable') // no git runner injected
    expect(result.worktrees).toHaveLength(1)
    expect(result.worktrees[0]?.reclaimable).toBe(true)
  })

  it('an active worktree is never reclaimable', async () => {
    const runNode: NodeRunner = () =>
      Promise.resolve(ok(payload({ summary: { registered: 1, removed: 0, kept: 1, byState: { active: 1 } } }, { state: 'active', reason: '#42 open' })))
    const result = await readWorktreeReport({ repoRoot: '/repo', worktreesCommand: 'node w.mjs', runNode, pathOps: posixPathOps })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.worktrees[0]?.state).toBe('active')
    expect(result.worktrees[0]?.reclaimable).toBe(false)
  })

  it('the sentinel triggers exactly one offline retry, appending --offline', async () => {
    const calls: (readonly string[])[] = []
    const runNode: NodeRunner = (args) => {
      calls.push(args)
      if (calls.length === 1) return Promise.resolve(nonzero(`${SCRIPT_FAIL_PREFIX}${GH_RESOLUTION_FAILED_SENTINEL}: no network`))
      return Promise.resolve(ok(payload()))
    }
    const result = await readWorktreeReport({ repoRoot: '/repo', worktreesCommand: 'node w.mjs', runNode, pathOps: posixPathOps })
    expect(calls).toEqual([
      ['w.mjs', 'report', '--json'],
      ['w.mjs', 'report', '--json', '--offline'],
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.githubResolution).toBe('unavailable')
  })

  it('a second failure after the retry is reported, never retried again', async () => {
    let calls = 0
    const runNode: NodeRunner = () => {
      calls++
      return Promise.resolve(nonzero(`${SCRIPT_FAIL_PREFIX}${GH_RESOLUTION_FAILED_SENTINEL}: still down`))
    }
    const result = await readWorktreeReport({ repoRoot: '/repo', worktreesCommand: 'node w.mjs', runNode, pathOps: posixPathOps })
    expect(calls).toBe(2)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('script-failed')
  })

  it('a FAIL stderr becomes script-failed, carrying the line verbatim', async () => {
    const runNode: NodeRunner = () => Promise.resolve(nonzero(`${SCRIPT_FAIL_PREFIX}not a git repository`))
    const result = await readWorktreeReport({ repoRoot: '/repo', worktreesCommand: 'node w.mjs', runNode, pathOps: posixPathOps })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('script-failed')
    expect(result.message).toBe(`${SCRIPT_FAIL_PREFIX}not a git repository`)
  })

  it('maps a timeout straight through', async () => {
    const runNode: NodeRunner = () => Promise.resolve({ ok: false, kind: 'timeout', timeoutMs: 60_000, stderr: '' })
    const result = await readWorktreeReport({ repoRoot: '/repo', worktreesCommand: 'node w.mjs', runNode, pathOps: posixPathOps })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('timeout')
  })

  it('maps not-found straight through', async () => {
    const runNode: NodeRunner = () => Promise.resolve({ ok: false, kind: 'not-found', command: 'node', searched: ['/usr/bin/node'] })
    const result = await readWorktreeReport({ repoRoot: '/repo', worktreesCommand: 'node w.mjs', runNode, pathOps: posixPathOps })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('not-found')
  })

  it('an unsupported runner is reported without spawning', async () => {
    let called = false
    const runNode: NodeRunner = () => {
      called = true
      return Promise.resolve(ok(''))
    }
    const result = await readWorktreeReport({ repoRoot: '/repo', worktreesCommand: 'pnpm run wt', runNode, pathOps: posixPathOps })
    expect(called).toBe(false)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('unsupported-runner')
    if (result.kind !== 'unsupported-runner') return
    expect(result.token).toBe('pnpm')
  })

  it('an unparseable command is reported without spawning', async () => {
    let called = false
    const runNode: NodeRunner = () => {
      called = true
      return Promise.resolve(ok(''))
    }
    const result = await readWorktreeReport({ repoRoot: '/repo', worktreesCommand: 'node "a b.mjs" && rm -rf /', runNode, pathOps: posixPathOps })
    expect(called).toBe(false)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('unparseable-command')
  })

  it('a malformed --json payload is reported as report-unparseable', async () => {
    const runNode: NodeRunner = () => Promise.resolve(ok('not json'))
    const result = await readWorktreeReport({ repoRoot: '/repo', worktreesCommand: 'node w.mjs', runNode, pathOps: posixPathOps })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('report-unparseable')
  })

  it('a failing readWorktrees join reports porcelainJoin: unavailable, report still ok: true', async () => {
    const runNode: NodeRunner = () => Promise.resolve(ok(payload()))
    const failingGit: WorktreesGitRunner = () => Promise.resolve({ ok: false, kind: 'nonzero', code: 1, stdout: '', stderr: 'boom' })
    const result = await readWorktreeReport({
      repoRoot: '/repo',
      worktreesCommand: 'node w.mjs',
      runNode,
      git: failingGit,
      pathOps: posixPathOps,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.porcelainJoin).toBe('unavailable')
    expect(result.worktrees[0]?.prunable).toBeNull()
    expect(result.worktrees[0]?.producer).toBeNull()
  })

  it('the join attaches prunable across a case-differing Windows path', async () => {
    const runNode: NodeRunner = () =>
      Promise.resolve(
        ok(
          payload(
            { mainRoot: 'c:/repo', integrationRef: 'origin/dev' },
            { path: 'c:/repo/.claude/worktrees/impl-42' },
          ),
        ),
      )
    const porcelain = [
      'worktree C:/repo',
      'HEAD deadbeefmain',
      'branch refs/heads/dev',
      '',
      'worktree C:/repo/.claude/worktrees/impl-42',
      'HEAD deadbeef42',
      'branch refs/heads/42-feature',
      'prunable gone',
      '',
    ].join('\n')
    const git: WorktreesGitRunner = (args) => {
      if (args[0] === 'worktree') return Promise.resolve({ ok: true, stdout: porcelain, stderr: '' })
      if (args[0] === 'config') return Promise.resolve({ ok: false, kind: 'nonzero', code: 1, stdout: '', stderr: '' })
      if (args[0] === 'log') return Promise.resolve({ ok: true, stdout: 'deadbeefmain subject\ndeadbeef42 #42 do things', stderr: '' })
      return Promise.resolve({ ok: false, kind: 'nonzero', code: 1, stdout: '', stderr: '' })
    }
    const result = await readWorktreeReport({
      repoRoot: 'C:\\repo',
      worktreesCommand: 'node w.mjs',
      runNode,
      git,
      pathOps: win32PathOps,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.porcelainJoin).toBe('joined')
    expect(result.worktrees[0]?.prunable).toBe(true)
    expect(result.worktrees[0]?.producer).toBe('operator')
  })
})
